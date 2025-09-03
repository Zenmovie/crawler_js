const runtime = chrome?.runtime || browser.runtime;
const tabsApi = chrome?.tabs || browser.tabs;

function $(sel){return document.querySelector(sel)}
function $all(sel){return Array.from(document.querySelectorAll(sel))}

let currentTabId = null;
let currentApp = null;
let allApps = {};
let urlItems = [];
let refreshTimer = null;

async function init() {
  const [tab] = await tabsApi.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;
  await refreshApps();
  bindUI();
  await selectActiveApp();
  await loadUrls();
  await queryBfsStatus();
}

async function refreshApps() {
  const res = await runtime.sendMessage({ type: 'bg:getApps' });
  if (!res.ok) return;
  allApps = res.apps || {};
  renderAppSelect();
}

function renderAppSelect() {
  const sel = $('#appSelect');
  sel.innerHTML = '';
  const entries = Object.values(allApps);
  if (entries.length === 0) {
    const opt = document.createElement('option'); opt.value = ''; opt.textContent = '—'; sel.appendChild(opt);
    return;
  }
  for (const app of entries) {
    const opt = document.createElement('option');
    opt.value = app.appId;
    const c = app.counters || { total: 0, page:0, api:0, asset:0 };
    const max = app.settings?.maxUrls;
    const suffix = max ? `${c.total}/${max}` : `${c.total}`;
    opt.textContent = `${app.origin}${app.scopePath || '/'}  · ${suffix}`;
    sel.appendChild(opt);
  }
  if (currentApp) sel.value = currentApp.appId;
}

async function selectActiveApp() {
  const res = await runtime.sendMessage({ type: 'bg:activeAppForTab', tabId: currentTabId });
  if (res.ok) {
    currentApp = res.app;
    if (!allApps[currentApp.appId]) { allApps[currentApp.appId] = currentApp; renderAppSelect(); }
    $('#appSelect').value = currentApp.appId;
    $('#deepMode').checked = !!currentApp.settings?.deepMode;
    renderSettings();
  }
}

function getFilters() {
  const kinds = $all('.kind:checked').map(el => el.value);
  const q = $('#search').value.trim();
  return { kind: kinds, q };
}

async function loadUrls() {
  const appId = $('#appSelect').value;
  if (!appId) return;
  await refreshApps();
  currentApp = allApps[appId] || currentApp;
  $('#appSelect').value = appId;
  const res = await runtime.sendMessage({ type: 'bg:getUrls', appId, filters: getFilters() });
  if (!res.ok) return;
  urlItems = res.items || [];
  renderList();
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  const c = currentApp?.counters || { total: 0, page:0, api:0, asset:0 };
  const max = currentApp?.settings?.maxUrls;
  const limitNote = max && c.total >= max ? ' · limit reached' : '';
  $('#counts').textContent = `${urlItems.length} shown · total ${c.total} (page ${c.page} / api ${c.api} / asset ${c.asset})${limitNote}`;
  for (const item of urlItems) {
    const row = document.createElement('div');
    row.className = 'row';
    const href = document.createElement('div'); href.className = 'href'; href.textContent = item.canonicalHref;
    const kind = document.createElement('div'); kind.className = 'chip'; kind.textContent = item.kind || '-';
    const via = document.createElement('div'); via.className = 'chip'; via.textContent = item.discoveredVia || '-';
    row.append(href, kind, via);
    list.appendChild(row);
  }
}

function bindUI() {
  $('#refreshApps').addEventListener('click', refreshApps);
  $('#appSelect').addEventListener('change', async () => {
    const appId = $('#appSelect').value;
    currentApp = allApps[appId];
    await loadUrls();
  });
  $('#startBtn').addEventListener('click', async () => {
    const scopePath = currentApp?.scopePath || '/';
    await runtime.sendMessage({ type: 'bg:startScan', tabId: currentTabId, scopePath });
    setTimeout(loadUrls, 400);
  });
  $('#pauseBtn').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:pauseScan', tabId: currentTabId });
    setTimeout(loadUrls, 200);
  });
  $('#rescanBtn').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:rescanNow', tabId: currentTabId });
    setTimeout(loadUrls, 400);
  });
  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Clear all URLs for this app?')) return;
    const appId = $('#appSelect').value;
    await runtime.sendMessage({ type: 'bg:resetApp', appId });
    await refreshApps();
    await loadUrls();
  });
  $('#search').addEventListener('input', debounce(loadUrls, 150));
  for (const el of $all('.kind')) el.addEventListener('change', loadUrls);
  $('#deepMode').addEventListener('change', async (e) => {
    const appId = $('#appSelect').value;
    const value = e.target.checked;
    const res = await runtime.sendMessage({ type: 'bg:updateSetting', appId, key: 'deepMode', value, tabId: currentTabId });
    if (res.ok) { currentApp = res.app; allApps[appId] = res.app; }
  });
  // Settings handlers
  $('#setIgnoreHash').addEventListener('change', onSettingToggle('ignoreHash'));
  $('#setIncludeAssets').addEventListener('change', async (e) => {
    const appId = $('#appSelect').value; if (!appId) return;
    const includeAssets = e.target.checked;
    const res = await runtime.sendMessage({ type: 'bg:updateSetting', appId, key: 'excludeAssets', value: !includeAssets });
    if (res.ok) { currentApp = res.app; allApps[appId] = res.app; }
  });
  $('#setMaxUrls').addEventListener('change', async (e) => {
    const appId = $('#appSelect').value; if (!appId) return;
    let v = parseInt(e.target.value, 10); if (!Number.isFinite(v) || v < 0) v = 0;
    const res = await runtime.sendMessage({ type: 'bg:updateSetting', appId, key: 'maxUrls', value: v });
    if (res.ok) { currentApp = res.app; allApps[appId] = res.app; renderAppSelect(); renderList(); }
  });
  $('#setNormalizeQuery').addEventListener('change', async (e) => {
    const appId = $('#appSelect').value; if (!appId) return;
    const value = e.target.value === 'sort' ? 'sort' : 'none';
    const res = await runtime.sendMessage({ type: 'bg:updateSetting', appId, key: 'normalizeQuery', value });
    if (res.ok) { currentApp = res.app; allApps[appId] = res.app; }
  });
  $('#applyRescan').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:rescanNow', tabId: currentTabId });
    setTimeout(loadUrls, 400);
  });
  $('#copyBtn').addEventListener('click', async () => {
    const text = urlItems.map(i => i.canonicalHref).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed'); }
  });
  $('#exportJson').addEventListener('click', () => exportBlob(JSON.stringify(urlItems, null, 2), 'application/json', 'urls.json'));
  $('#exportCsv').addEventListener('click', () => exportBlob(toCsv(urlItems), 'text/csv', 'urls.csv'));

  // Live updates: listen to runtime messages
  runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ui:dataChanged') {
      // throttle update
      if (refreshTimer) return true;
      refreshTimer = setTimeout(() => { refreshTimer = null; loadUrls(); }, 250);
      return true;
    } else if (msg?.type === 'ui:bfsStatus') {
      // Update BFS status when it's about this tab (or no tab binding in panel)
      if (currentTabId && msg.tabId !== currentTabId) return false;
      renderBfsStatus(msg.status);
      renderBfsProgress(msg.status);
      return true;
    }
    return false;
  });

  // BFS controls
  $('#bfsStart').addEventListener('click', async () => {
    const maxDepth = parseInt($('#bfsDepth').value, 10) || 0;
    const rateMs = parseInt($('#bfsRate').value, 10) || 0;
    await runtime.sendMessage({ type: 'bg:bfsStart', tabId: currentTabId, maxDepth, rateMs });
    // fetch status shortly after
    setTimeout(queryBfsStatus, 300);
  });
  $('#bfsPause').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:bfsPause', tabId: currentTabId });
    setTimeout(queryBfsStatus, 200);
  });
  $('#bfsStop').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:bfsStop', tabId: currentTabId });
    setTimeout(queryBfsStatus, 200);
  });
  $('#bfsClear').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:bfsClearQueue', tabId: currentTabId });
    setTimeout(queryBfsStatus, 150);
  });
  $('#bfsSkip').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:bfsSkip', tabId: currentTabId });
    setTimeout(queryBfsStatus, 200);
  });
  // Next list controls
  $('#bfsNextRefresh').addEventListener('click', queryBfsQueue);
  $('#bfsNextCount').addEventListener('change', queryBfsQueue);
  $('#bfsSkipN').addEventListener('click', async () => {
    const n = parseInt($('#bfsSkipCount').value, 10) || 0;
    if (n > 0) {
      await runtime.sendMessage({ type: 'bg:bfsSkipN', tabId: currentTabId, count: n });
      queryBfsStatus();
      queryBfsQueue();
    }
  });
  $('#bfsOpenNext').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:bfsOpenNext', tabId: currentTabId });
  });
  $('#bfsCopyNext').addEventListener('click', async () => {
    const limit = parseInt($('#bfsNextCount').value, 10) || 10;
    const res = await runtime.sendMessage({ type: 'bg:bfsQueue', tabId: currentTabId, limit });
    if (!res.ok) return;
    const lines = (res.items || []).map(it => it.url).join('\n');
    try { await navigator.clipboard.writeText(lines); toast('Copied'); } catch { toast('Copy failed'); }
  });
  $('#bfsEnqueueBtn').addEventListener('click', async () => {
    const url = $('#bfsEnqueueInput').value.trim();
    if (!url) return;
    const res = await runtime.sendMessage({ type: 'bg:bfsEnqueue', tabId: currentTabId, url });
    const msgEl = document.getElementById('bfsEnqueueMsg');
    function showMsg(text, ok) { if (!msgEl) return; msgEl.textContent = text; msgEl.classList.toggle('error', !ok); msgEl.classList.toggle('ok', !!ok); setTimeout(()=>{ msgEl.textContent=''; msgEl.classList.remove('error','ok'); }, 2500); }
    if (res.ok && res.enqueued) {
      $('#bfsEnqueueInput').value = '';
      showMsg('Enqueued', true);
      queryBfsQueue(); queryBfsStatus();
    } else if (res.ok && !res.enqueued) {
      const reason = res.reason || 'duplicate';
      const text = reason === 'duplicate' ? 'Already queued/visited' : (reason === 'not_page' ? 'Not a page' : 'Not enqueued');
      showMsg(text, false);
    } else {
      const err = res.error || 'Error';
      const text = err === 'bad_url' ? 'Invalid URL' : (err === 'out_of_scope' ? 'Out of scope' : 'Error');
      showMsg(text, false);
    }
  });
}

function toCsv(items) {
  const cols = ['href','canonicalHref','kind','method','status','discoveredVia','ts'];
  const head = cols.join(',');
  const rows = items.map(i => cols.map(k => csvCell(i[k])).join(','));
  return [head, ...rows].join('\n');
}
function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replaceAll('"', '""');
  if (/[",\n]/.test(s)) return '"' + s + '"';
  return s;
}

function exportBlob(data, type, filename) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(msg) { document.title = msg; setTimeout(() => document.title = 'App URL Crawler – Side Panel', 700); }
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }}

function onSettingToggle(key) {
  return async (e) => {
    const appId = $('#appSelect').value; if (!appId) return;
    const value = !!e.target.checked;
    const res = await runtime.sendMessage({ type: 'bg:updateSetting', appId, key, value });
    if (res.ok) { currentApp = res.app; allApps[appId] = res.app; }
  };
}

function renderSettings() {
  const s = currentApp?.settings || {};
  $('#setIgnoreHash').checked = !!s.ignoreHash;
  $('#setIncludeAssets').checked = !s.excludeAssets;
  $('#setMaxUrls').value = Number.isFinite(s.maxUrls) ? s.maxUrls : 0;
  $('#setNormalizeQuery').value = s.normalizeQuery === 'sort' ? 'sort' : 'none';
}

async function queryBfsStatus() {
  const res = await runtime.sendMessage({ type: 'bg:bfsStatus', tabId: currentTabId });
  if (res.ok) { renderBfsStatus(res.status); renderBfsProgress(res.status); }
}

function renderBfsStatus(status) {
  const el = $('#bfsStatus');
  if (!status) { el.textContent = 'idle'; return; }
  const parts = [];
  parts.push(status.running ? 'running' : 'paused');
  parts.push(`depth<=${status.maxDepth}`);
  parts.push(`rate=${status.rateMs}ms`);
  parts.push(`visited=${status.visited || 0}`);
  parts.push(`queue=${status.queueLen}`);
  if (status.visiting?.url) {
    try {
      const u = new URL(status.visiting.url);
      parts.push(`now: ${u.pathname}${u.search}`);
    } catch { parts.push(`now: ${status.visiting.url}`); }
  }
  el.textContent = parts.join(' · ');
}

function renderBfsProgress(status) {
  const wrap = document.getElementById('bfsProgressWrap');
  const bar = document.getElementById('bfsProgressBar');
  const vEl = document.getElementById('bfsVisited');
  const qEl = document.getElementById('bfsQueued');
  const rEl = document.getElementById('bfsReason');
  if (!wrap || !bar || !vEl || !qEl) return;
  if (!status) { wrap.style.display = 'none'; return; }
  const visited = status.visited || 0;
  const queued = status.queueLen || 0;
  vEl.textContent = visited;
  qEl.textContent = queued;
  const denom = visited + queued;
  const pct = denom > 0 ? Math.round((visited / denom) * 100) : 0;
  bar.style.width = pct + '%';
  wrap.style.display = '';
  // Reason / warn
  const reason = status.reason || '';
  if (rEl) { rEl.textContent = reason ? reason : ''; rEl.style.display = reason ? '' : 'none'; }
  if (reason === 'limit') wrap.classList.add('warn'); else wrap.classList.remove('warn');
  // Show 'Next' section if BFS active or queued
  const nextWrap = document.getElementById('bfsNextWrap');
  if (nextWrap) nextWrap.style.display = (status.running || queued > 0) ? '' : 'none';
  if (status.running || queued > 0) queryBfsQueue();
}

async function queryBfsQueue() {
  const limit = parseInt(document.getElementById('bfsNextCount').value, 10) || 10;
  const res = await runtime.sendMessage({ type: 'bg:bfsQueue', tabId: currentTabId, limit });
  if (!res.ok) return;
  renderBfsNext(res.items || []);
}

function renderBfsNext(items) {
  const list = document.getElementById('bfsNextList');
  if (!list) return;
  list.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const href = document.createElement('div'); href.className = 'href';
    try { const u = new URL(it.url); href.textContent = `${u.pathname}${u.search}`; } catch { href.textContent = it.url; }
    const depth = document.createElement('div'); depth.className = 'chip'; depth.textContent = `d${it.depth}`;
    const act = document.createElement('div'); act.className = 'chip'; act.textContent = 'queued';
    row.append(href, depth, act);
    list.appendChild(row);
  }
}

init().catch(console.error);
