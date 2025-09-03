import { ensureApp, getApps, getApp, updateApp, addOrUpdateUrlRecord, listUrls, clearUrls, buildAppId, normalizeScope } from './db.js';
import { toAbsoluteUrl, canonicalize, getOrigin } from './normalize.js';
import { inScope, classifyKind } from './filters.js';

const isChrome = typeof chrome !== 'undefined';
const runtime = chrome?.runtime || browser.runtime;
const tabsApi = chrome?.tabs || browser.tabs;
const scripting = chrome?.scripting || browser.scripting;
const webNavigation = chrome?.webNavigation || browser.webNavigation;
const storage = chrome.storage?.local || browser.storage.local;
const storageSession = chrome.storage?.session; // Chrome MV3; may be undefined in Firefox
const sidePanelApi = chrome?.sidePanel;

// BFS crawler state per tab: manages queue and pacing
const BFS_STATES = new Map(); // tabId -> { appId, running, maxDepth, rateMs, collectMs, queue:[{url, depth}], seen:Set, visiting:null|{url, depth}, visited:number, reason:string|null }

function bfsKey(tabId) { return `bfs:${tabId}`; }

async function persistBfs(tabId) {
  try {
    if (!storageSession) return; // not supported
    const s = BFS_STATES.get(tabId);
    if (!s) { await storageSession.remove(bfsKey(tabId)); return; }
    const serial = {
      appId: s.appId,
      running: !!s.running,
      maxDepth: s.maxDepth,
      rateMs: s.rateMs,
      collectMs: s.collectMs,
      queue: s.queue,
      seen: Array.from(s.seen || []),
      visiting: s.visiting || null,
      visited: s.visited || 0,
      reason: s.reason || null,
    };
    await storageSession.set({ [bfsKey(tabId)]: serial });
  } catch {}
}

async function rehydrateBfsFromSession() {
  try {
    if (!storageSession) return;
    const all = await storageSession.get(null);
    for (const [key, val] of Object.entries(all || {})) {
      if (!key.startsWith('bfs:')) continue;
      const tabId = Number(key.slice(4));
      const s = val;
      if (!s || !s.appId) continue;
      BFS_STATES.set(tabId, {
        appId: s.appId,
        running: !!s.running,
        maxDepth: s.maxDepth ?? 2,
        rateMs: s.rateMs ?? 500,
        collectMs: s.collectMs ?? 400,
        queue: Array.isArray(s.queue) ? s.queue : [],
        seen: new Set(Array.isArray(s.seen) ? s.seen : []),
        visiting: s.visiting || null,
        visited: s.visited || 0,
        reason: s.reason || null,
      });
      bfsBroadcast(tabId);
      if (s.running) bfsTick(tabId);
    }
  } catch {}
}

function bfsBroadcast(tabId) {
  const s = BFS_STATES.get(tabId);
  runtime.sendMessage({
    type: 'ui:bfsStatus',
    tabId,
    status: s ? {
      running: !!s.running,
      appId: s.appId,
      maxDepth: s.maxDepth,
      rateMs: s.rateMs,
      queueLen: s.queue.length,
      visiting: s.visiting,
      visited: s.visited || 0,
      reason: s.reason || null,
    } : null,
  }).catch(() => {});
}

async function bfsStart(tabId, { maxDepth = 2, rateMs = 500 } = {}) {
  const tab = await tabsApi.get(tabId);
  const origin = getOrigin(tab.url);
  const app = await ensureApp({ origin, scopePath: '/' });
  const seedAbs = toAbsoluteUrl(tab.url, tab.url);
  const seedCanon = canonicalize(seedAbs, {
    ignoreHash: !!app.settings?.ignoreHash,
    normalizeQuery: app.settings?.normalizeQuery || 'sort',
    stripIndexHtml: true,
  });
  const seen = new Set([seedCanon]);
  const state = {
    appId: app.appId,
    running: true,
    maxDepth: Math.max(0, Number(maxDepth) || 0),
    rateMs: Math.max(0, Number(rateMs) || 0),
    collectMs: 400,
    queue: [{ url: seedAbs, depth: 0 }],
    seen,
    visiting: null,
    visited: 0,
    reason: null,
  };
  BFS_STATES.set(tabId, state);
  // mark as active scan so webNavigation events are processed
  const active = await getActiveScans();
  active[tabId] = { appId: app.appId, running: true };
  await setActiveScans(active);
  try { await injectContent(tabId); await tabsApi.sendMessage(tabId, { type: 'cs:enable', appId: app.appId, scopePath: app.scopePath, deepMode: !!app.settings?.deepMode }); } catch {}
  bfsBroadcast(tabId);
  await persistBfs(tabId);
  bfsTick(tabId);
}

function bfsPause(tabId) {
  const s = BFS_STATES.get(tabId);
  if (!s) return;
  s.running = false;
  s.reason = 'paused';
  bfsBroadcast(tabId);
  persistBfs(tabId);
}

function bfsStop(tabId) {
  const s = BFS_STATES.get(tabId);
  if (!s) return;
  s.running = false;
  s.queue = [];
  s.visiting = null;
  s.reason = 'stopped';
  bfsBroadcast(tabId);
  persistBfs(tabId);
}

function bfsClearQueue(tabId) {
  const s = BFS_STATES.get(tabId);
  if (!s) return;
  s.queue = [];
  bfsBroadcast(tabId);
  persistBfs(tabId);
}

async function bfsSkip(tabId) {
  const s = BFS_STATES.get(tabId);
  if (!s) return;
  if (s.queue.length > 0) {
    const next = s.queue.shift();
    s.visiting = next;
    s.reason = null;
    bfsBroadcast(tabId);
    persistBfs(tabId);
    try { await tabsApi.update(tabId, { url: next.url }); } catch {}
  } else {
    s.visiting = null;
    bfsBroadcast(tabId);
    persistBfs(tabId);
  }
}

async function bfsTick(tabId) {
  const s = BFS_STATES.get(tabId);
  if (!s || !s.running) return;
  if (s.visiting) return; // already loading/collecting
  if (!s.queue.length) { s.running = false; bfsBroadcast(tabId); return; }
  const next = s.queue.shift();
  s.visiting = next;
  s.reason = null;
  bfsBroadcast(tabId);
  persistBfs(tabId);
  try {
    await tabsApi.update(tabId, { url: next.url });
  } catch {
    s.visiting = null;
    setTimeout(() => bfsTick(tabId), s.rateMs);
  }
}

function bfsOnDiscovered(tabId, app, baseUrl, hrefs) {
  const s = BFS_STATES.get(tabId);
  if (!s || !s.running) return;
  const parentDepth = s.visiting?.depth ?? 0;
  const nextDepth = parentDepth + 1;
  if (nextDepth > s.maxDepth) return;
  for (const raw of hrefs || []) {
    const abs = toAbsoluteUrl(raw, baseUrl);
    if (!abs) continue;
    if (!inScope(app, abs)) continue;
    const canon = canonicalize(abs, {
      ignoreHash: !!app.settings?.ignoreHash,
      normalizeQuery: app.settings?.normalizeQuery || 'sort',
      stripIndexHtml: true,
    });
    if (s.seen.has(canon)) continue;
    const kind = classifyKind(canon);
    if (kind !== 'page') continue; // BFS по страницам
    s.seen.add(canon);
    s.queue.push({ url: abs, depth: nextDepth });
  }
  bfsBroadcast(tabId);
  persistBfs(tabId);
}

function bfsOnNavigated(tabId, url) {
  const s = BFS_STATES.get(tabId);
  if (!s || !s.running) return;
  try { tabsApi.sendMessage(tabId, { type: 'cs:extractNow' }); } catch {}
  const wait = (s.collectMs || 400) + (s.rateMs || 0);
  setTimeout(() => {
    const s2 = BFS_STATES.get(tabId);
    if (!s2) return;
    // count a visit when we advanced to a page
    if (s2.visiting) s2.visited = (s2.visited || 0) + 1;
    s2.visiting = null;
    bfsBroadcast(tabId);
    persistBfs(tabId);
    bfsTick(tabId);
  }, wait);
}

// Active scans: { [tabId]: { appId, running: true } }
async function getActiveScans() {
  return (await storage.get('activeScans')).activeScans || {};
}
async function setActiveScans(active) {
  await storage.set({ activeScans: active });
}

async function deriveAppFromTab(tabId) {
  const tab = await tabsApi.get(tabId);
  if (!tab?.url) throw new Error('No tab URL');
  const origin = getOrigin(tab.url);
  const scopePath = '/';
  const app = await ensureApp({ origin, scopePath });
  return app;
}

async function injectContent(tabId) {
  try {
    await scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
  } catch (e) {
    // ignore if already injected or cannot inject
  }
}

async function handleDiscovered({ appId, baseUrl, hrefs, via, ts }) {
  const apps = await getApps();
  const app = apps[appId];
  if (!app) return;
  for (const raw of hrefs || []) {
    const abs = toAbsoluteUrl(raw, baseUrl);
    if (!abs) continue;
    if (!inScope(app, abs)) continue;
    const canonicalHref = canonicalize(abs, {
      ignoreHash: !!app.settings?.ignoreHash,
      normalizeQuery: app.settings?.normalizeQuery || 'sort',
      stripIndexHtml: true,
    });
    const kind = classifyKind(canonicalHref);
    if (app.settings?.excludeAssets && kind === 'asset') continue;
    const rec = {
      appId,
      href: abs,
      canonicalHref,
      kind,
      method: null,
      status: null,
      discoveredVia: via,
      ts: ts || Date.now(),
      source: baseUrl,
    };
    await addOrUpdateUrlRecord(rec);
  }
  await enforceLimits(appId);
  try { await runtime.sendMessage({ type: 'ui:dataChanged', appId }); } catch {}
}

runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'bg:getApps': {
          const apps = await getApps();
          sendResponse({ ok: true, apps });
          break;
        }
        case 'bg:getUrls': {
          const { appId, filters } = msg;
          const all = await listUrls(appId);
          let items = all;
          if (filters?.kind && Array.isArray(filters.kind)) {
            const kset = new Set(filters.kind);
            items = items.filter(r => kset.has(r.kind));
          }
          if (filters?.q) {
            const q = filters.q.toLowerCase();
            items = items.filter(r => r.canonicalHref.toLowerCase().includes(q));
          }
          sendResponse({ ok: true, items });
          break;
        }
        case 'bg:startScan': {
          const tabId = msg.tabId || sender?.tab?.id;
          if (!tabId) throw new Error('No tabId');
          const tab = await tabsApi.get(tabId);
          const origin = getOrigin(tab.url);
          const scopePath = normalizeScope(msg.scopePath || '/');
          const app = await ensureApp({ origin, scopePath });
          const appId = app.appId;
          const active = await getActiveScans();
          active[tabId] = { appId, running: true };
          await setActiveScans(active);
          await injectContent(tabId);
          // enable watchers
          await tabsApi.sendMessage(tabId, { type: 'cs:enable', appId, scopePath, deepMode: !!app.settings?.deepMode });
          sendResponse({ ok: true, app });
          break;
        }
        case 'bg:bfsStart': {
          const tabId = msg.tabId || sender?.tab?.id;
          if (!tabId) throw new Error('No tabId');
          await bfsStart(tabId, { maxDepth: msg.maxDepth, rateMs: msg.rateMs });
          sendResponse({ ok: true });
          break;
        }
        case 'bg:bfsPause': {
          const tabId = msg.tabId || sender?.tab?.id;
          bfsPause(tabId);
          sendResponse({ ok: true });
          break;
        }
        case 'bg:bfsStop': {
          const tabId = msg.tabId || sender?.tab?.id;
          bfsStop(tabId);
          sendResponse({ ok: true });
          break;
        }
        case 'bg:bfsStatus': {
          const tabId = msg.tabId || sender?.tab?.id;
          const s = BFS_STATES.get(tabId);
          sendResponse({ ok: true, status: s ? { running: s.running, maxDepth: s.maxDepth, rateMs: s.rateMs, queueLen: s.queue.length, visiting: s.visiting, visited: s.visited || 0, reason: s.reason || null } : null });
          break;
        }
        case 'bg:bfsQueue': {
          const tabId = msg.tabId || sender?.tab?.id;
          const s = BFS_STATES.get(tabId);
          const limit = Math.max(0, Number(msg.limit) || 0);
          const items = s ? s.queue.slice(0, limit || s.queue.length) : [];
          sendResponse({ ok: true, items });
          break;
        }
        case 'bg:bfsClearQueue': {
          const tabId = msg.tabId || sender?.tab?.id;
          bfsClearQueue(tabId);
          sendResponse({ ok: true });
          break;
        }
        case 'bg:bfsSkip': {
          const tabId = msg.tabId || sender?.tab?.id;
          await bfsSkip(tabId);
          sendResponse({ ok: true });
          break;
        }
        case 'bg:bfsSkipN': {
          const tabId = msg.tabId || sender?.tab?.id;
          const count = Math.max(0, Number(msg.count) || 0);
          const s = BFS_STATES.get(tabId);
          if (s && count > 0) {
            s.queue.splice(0, count);
            bfsBroadcast(tabId);
            await persistBfs(tabId);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'bg:bfsEnqueue': {
          const tabId = msg.tabId || sender?.tab?.id;
          const url = String(msg.url || '').trim();
          const s = BFS_STATES.get(tabId);
          if (!s || !url) { sendResponse({ ok: true }); break; }
          const app = await getApp(s.appId);
          const tab = await tabsApi.get(tabId);
          const abs = toAbsoluteUrl(url, tab?.url || undefined);
          if (!abs) { sendResponse({ ok: false, error: 'bad_url' }); break; }
          if (!inScope(app, abs)) { sendResponse({ ok: false, error: 'out_of_scope' }); break; }
          const canon = canonicalize(abs, {
            ignoreHash: !!app.settings?.ignoreHash,
            normalizeQuery: app.settings?.normalizeQuery || 'sort',
            stripIndexHtml: true,
          });
          const k = classifyKind(canon);
          if (!s.seen.has(canon) && k === 'page') {
            s.seen.add(canon);
            const depth = s.visiting ? Math.min(s.maxDepth, (s.visiting.depth || 0) + 1) : 0;
            s.queue.push({ url: abs, depth });
            bfsBroadcast(tabId);
            await persistBfs(tabId);
            sendResponse({ ok: true, enqueued: true });
          } else {
            const reason = s.seen.has(canon) ? 'duplicate' : (k !== 'page' ? 'not_page' : 'unknown');
            sendResponse({ ok: true, enqueued: false, reason });
          }
          break;
        }
        case 'bg:bfsOpenNext': {
          const tabId = msg.tabId || sender?.tab?.id;
          const s = BFS_STATES.get(tabId);
          if (!s || s.queue.length === 0) { sendResponse({ ok: true, opened: false }); break; }
          const next = s.queue[0];
          try {
            const cur = await tabsApi.get(tabId);
            await tabsApi.create({ url: next.url, windowId: cur.windowId, active: false });
            sendResponse({ ok: true, opened: true });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          break;
        }
        case 'bg:pauseScan': {
          const tabId = msg.tabId || sender?.tab?.id;
          const active = await getActiveScans();
          if (active[tabId]) active[tabId].running = false;
          await setActiveScans(active);
          try { await tabsApi.sendMessage(tabId, { type: 'cs:disable' }); } catch {}
          sendResponse({ ok: true });
          break;
        }
        case 'bg:resetApp': {
          const { appId } = msg;
          await clearUrls(appId);
          sendResponse({ ok: true });
          break;
        }
        case 'bg:rescanNow': {
          const tabId = msg.tabId || sender?.tab?.id;
          await injectContent(tabId);
          await tabsApi.sendMessage(tabId, { type: 'cs:extractNow' });
          sendResponse({ ok: true });
          break;
        }
        case 'bg:openSidePanel': {
          const tabId = msg.tabId || sender?.tab?.id;
          if (sidePanelApi && tabId) {
            try {
              await sidePanelApi.setOptions({ tabId, path: 'ui/sidepanel.html', enabled: true });
              // open is available in recent Chrome versions; ignore if not
              if (sidePanelApi.open) await sidePanelApi.open({ tabId });
            } catch {}
          }
          sendResponse({ ok: true });
          break;
        }
        case 'bg:updateScope': {
          const { appId, scopePath } = msg;
          const app = await updateApp(appId, { scopePath: normalizeScope(scopePath) });
          sendResponse({ ok: true, app });
          break;
        }
        case 'bg:updateSetting': {
          const { appId, key, value } = msg;
          const app = await getApp(appId);
          if (!app) throw new Error('app_not_found');
          const settings = { ...(app.settings || {}) };
          settings[key] = value;
          const updated = await updateApp(appId, { settings });
          // if deepMode changed and there is an active scan on the current tab, inform content
          const tabId = msg.tabId || sender?.tab?.id;
          if (tabId) {
            try { await tabsApi.sendMessage(tabId, { type: 'cs:setDeepMode', deepMode: !!settings.deepMode }); } catch {}
          }
          sendResponse({ ok: true, app: updated });
          break;
        }
        case 'bg:apiRequest': {
          const { appId, url, method, status, baseUrl, ts } = msg;
          const app = await getApp(appId);
          if (!app) throw new Error('app_not_found');
          const abs = toAbsoluteUrl(url, baseUrl);
          if (!abs) { sendResponse({ ok: true }); break; }
          if (!inScope(app, abs)) { sendResponse({ ok: true }); break; }
          const canonicalHref = canonicalize(abs, {
            ignoreHash: !!app.settings?.ignoreHash,
            normalizeQuery: app.settings?.normalizeQuery || 'sort',
            stripIndexHtml: true,
          });
          await addOrUpdateUrlRecord({
            appId,
            href: abs,
            canonicalHref,
            kind: 'api',
            method: method || null,
            status: typeof status === 'number' ? status : null,
            discoveredVia: 'api-hook',
            ts: ts || Date.now(),
            source: baseUrl,
          });
          await enforceLimits(appId);
          try { await runtime.sendMessage({ type: 'ui:dataChanged', appId }); } catch {}
          sendResponse({ ok: true });
          break;
        }
        case 'bg:activeAppForTab': {
          const tabId = msg.tabId || sender?.tab?.id;
          const tab = await tabsApi.get(tabId);
          const origin = getOrigin(tab.url);
          const scopePath = '/';
          const app = await ensureApp({ origin, scopePath });
          sendResponse({ ok: true, app });
          break;
        }
        // messages from content script
        case 'bg:discoveredLinks': {
          const { appId, baseUrl, hrefs, via, ts } = msg;
          await handleDiscovered({ appId, baseUrl, hrefs, via, ts });
          // enqueue for BFS if active
          try {
            const tabId = sender?.tab?.id;
            if (tabId) {
              const apps = await getApps();
              const app = apps[appId];
              if (app) bfsOnDiscovered(tabId, app, baseUrl, hrefs);
            }
          } catch {}
          sendResponse({ ok: true });
          break;
        }
        case 'bg:spaNavigated': {
          const { appId, url, via, ts } = msg;
          await handleDiscovered({ appId, baseUrl: url, hrefs: [url], via: via || 'spa-history', ts });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown_message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  // keep channel open for async
  return true;
});

// webNavigation listeners
webNavigation.onCommitted.addListener(async (details) => {
  try {
    if (details.frameId !== 0) return; // main frame only
    const active = await getActiveScans();
    const track = active[details.tabId];
    const bfs = BFS_STATES.get(details.tabId);
    if (!track?.running && !(bfs && bfs.running)) return;
    // ensure content script is present after navigation
    await injectContent(details.tabId);
    const appId = track?.appId || bfs?.appId;
    if (appId) {
      await handleDiscovered({ appId, baseUrl: details.url, hrefs: [details.url], via: 'webNavigation', ts: Date.now() });
      try { await runtime.sendMessage({ type: 'ui:dataChanged', appId }); } catch {}
    }
    bfsOnNavigated(details.tabId, details.url);
  } catch {}
});

webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  try {
    if (details.frameId !== 0) return;
    const active = await getActiveScans();
    const track = active[details.tabId];
    const bfs = BFS_STATES.get(details.tabId);
    if (!track?.running && !(bfs && bfs.running)) return;
    const appId = track?.appId || bfs?.appId;
    if (appId) {
      await handleDiscovered({ appId, baseUrl: details.url, hrefs: [details.url], via: 'webNavigation:history', ts: Date.now() });
      try { await runtime.sendMessage({ type: 'ui:dataChanged', appId }); } catch {}
    }
    bfsOnNavigated(details.tabId, details.url);
  } catch {}
});

// Clean up activeScans when a tab is closed
tabsApi.onRemoved.addListener(async (tabId) => {
  const active = await getActiveScans();
  if (active[tabId]) {
    delete active[tabId];
    await setActiveScans(active);
  }
  if (BFS_STATES.has(tabId)) {
    BFS_STATES.delete(tabId);
    try { if (storageSession) await storageSession.remove(bfsKey(tabId)); } catch {}
  }
});

// Rehydrate BFS state from session storage when service worker spins up
rehydrateBfsFromSession();

async function enforceLimits(appId) {
  try {
    const app = await getApp(appId);
    if (!app) return;
    const max = app.settings?.maxUrls;
    if (!max || app.counters?.total < max) return;
    // Pause all scans for this appId
    const active = await getActiveScans();
    const tabIds = Object.entries(active).filter(([, v]) => v.appId === appId && v.running).map(([k]) => Number(k));
    let changed = false;
    for (const tid of tabIds) {
      active[tid].running = false; changed = true;
      try { await tabsApi.sendMessage(tid, { type: 'cs:disable' }); } catch {}
      const s = BFS_STATES.get(tid);
      if (s && s.running) { s.running = false; s.reason = 'limit'; bfsBroadcast(tid); persistBfs(tid); }
    }
    if (changed) await setActiveScans(active);
  } catch {}
}
