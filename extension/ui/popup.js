const runtime = chrome?.runtime || browser.runtime;
const tabsApi = chrome?.tabs || browser.tabs;

function $(sel){return document.querySelector(sel)}
function $all(sel){return Array.from(document.querySelectorAll(sel))}

let currentTabId = null;
let currentApp = null;
let allApps = {};
let urlItems = [];

async function init() {
  const [tab] = await tabsApi.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  await refreshApps();
  bindUI();
  await selectActiveApp();
  await loadUrls();
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
  // Derive from current tab
  const res = await runtime.sendMessage({ type: 'bg:activeAppForTab', tabId: currentTabId });
  if (res.ok) {
    currentApp = res.app;
    if (!allApps[currentApp.appId]) { allApps[currentApp.appId] = currentApp; renderAppSelect(); }
    $('#appSelect').value = currentApp.appId;
    // reflect settings
    $('#deepMode').checked = !!currentApp.settings?.deepMode;
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
  // Refresh apps to keep counters up to date
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
  $('#sideBtn').addEventListener('click', async () => {
    await runtime.sendMessage({ type: 'bg:openSidePanel', tabId: currentTabId });
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
    if (res.ok) {
      currentApp = res.app; allApps[appId] = res.app;
    }
  });
  $('#copyBtn').addEventListener('click', async () => {
    const text = urlItems.map(i => i.canonicalHref).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed'); }
  });
  $('#exportJson').addEventListener('click', () => exportBlob(JSON.stringify(urlItems, null, 2), 'application/json', 'urls.json'));
  $('#exportCsv').addEventListener('click', () => exportBlob(toCsv(urlItems), 'text/csv', 'urls.csv'));
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

function toast(msg) { /* simple visual cue via title */ document.title = msg; setTimeout(() => document.title = 'App URL Crawler', 700); }
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }}

init().catch(console.error);
