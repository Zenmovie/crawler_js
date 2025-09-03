(() => {
  if (window.__appCrawlerInjected) return;
  window.__appCrawlerInjected = true;

  const runtime = (typeof chrome !== 'undefined' && chrome.runtime) || (typeof browser !== 'undefined' && browser.runtime) || null;
  let enabled = false;
  let appId = null;
  let scopePath = '/';
  let mo = null;
  let deepMode = false;
  let overlay = null;

  const SEND_BATCH_INTERVAL = 300; // ms
  let pending = new Set();
  let batchTimer = null;

  function safeSend(msg) {
    try {
      if (!runtime || !runtime.sendMessage) return;
      const p = runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* context may be invalidated during SW reload */ }
  }

  function scheduleFlush(via = 'dom') {
    if (!enabled) return;
    if (batchTimer) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      if (pending.size === 0) return;
      const hrefs = Array.from(pending);
      pending.clear();
      safeSend({
        type: 'bg:discoveredLinks',
        appId,
        baseUrl: location.href,
        hrefs,
        via,
        ts: Date.now(),
      });
    }, SEND_BATCH_INTERVAL);
  }

  function collectAttribute(selector, attr) {
    for (const el of document.querySelectorAll(selector)) {
      const v = el.getAttribute(attr);
      if (v) pending.add(v);
    }
  }

  function metaRefreshUrls() {
    const out = [];
    for (const m of document.querySelectorAll('meta[http-equiv="refresh" i]')) {
      const content = m.getAttribute('content') || '';
      const match = content.match(/url=([^;]+)/i);
      if (match) out.push(match[1].trim());
    }
    return out;
  }

  function extractLinksNow() {
    pending.clear();
    // Classic link-like elements
    collectAttribute('a[href]', 'href');
    collectAttribute('area[href]', 'href');
    collectAttribute('link[href]', 'href');
    collectAttribute('form[action]', 'action');
    collectAttribute('iframe[src]', 'src');
    collectAttribute('source[src]', 'src');
    collectAttribute('img[src]', 'src');
    // meta refresh
    for (const u of metaRefreshUrls()) pending.add(u);
    scheduleFlush('dom');
  }

  function installObserver() {
    if (mo) return;
    mo = new MutationObserver((mutList) => {
      for (const m of mutList) {
        if (m.type === 'attributes') {
          const attr = m.attributeName;
          if (!attr) continue;
          if (['href', 'src', 'action'].includes(attr)) {
            const v = m.target.getAttribute(attr);
            if (v) pending.add(v);
          }
        } else if (m.type === 'childList') {
          // new nodes may contain links
          for (const node of m.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.hasAttribute?.('href')) pending.add(node.getAttribute('href'));
            if (node.hasAttribute?.('src')) pending.add(node.getAttribute('src'));
            if (node.hasAttribute?.('action')) pending.add(node.getAttribute('action'));
            for (const el of node.querySelectorAll?.('[href],[src],[action]') || []) {
              const href = el.getAttribute('href');
              if (href) pending.add(href);
              const src = el.getAttribute('src');
              if (src) pending.add(src);
              const action = el.getAttribute('action');
              if (action) pending.add(action);
            }
          }
        }
      }
      scheduleFlush('mutation');
    });
    mo.observe(document.documentElement || document.body, {
      attributes: true,
      attributeFilter: ['href', 'src', 'action'],
      subtree: true,
      childList: true,
    });
  }

  // SPA navigation hooks
  function installHistoryHooks() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    function notify(via) {
      if (!enabled) return;
      safeSend({ type: 'bg:spaNavigated', appId, url: location.href, via, ts: Date.now() });
    }
    history.pushState = function (...args) { const r = origPush.apply(this, args); setTimeout(() => notify('history:pushState')); return r; };
    history.replaceState = function (...args) { const r = origReplace.apply(this, args); setTimeout(() => notify('history:replaceState')); return r; };
    window.addEventListener('popstate', () => notify('history:popstate'));
    if (window.navigation && window.navigation.addEventListener) {
      try { window.navigation.addEventListener('navigate', () => notify('navigation-api')); } catch {}
    }
  }

  // Network deep mode hooks (fetch/XHR)
  function installNetworkHooksOnce() {
    // Wrap fetch
    const origFetch = window.fetch;
    if (origFetch && !origFetch.__wrappedForCrawler) {
      const wrapped = function(input, init) {
        try {
          const method = (init && init.method) || (typeof input === 'object' && input?.method) || 'GET';
          const url = typeof input === 'string' ? input : (input?.url || String(input));
          const baseUrl = location.href;
          const p = origFetch.apply(this, arguments);
          p.then((res) => {
            if (!deepMode) return;
            try {
              const status = res.status;
              sendApi(url, method, status, baseUrl);
            } catch {}
          }).catch(() => {
            if (!deepMode) return;
            try { sendApi(url, method, undefined, baseUrl); } catch {}
          });
          return p;
        } catch {
          return origFetch.apply(this, arguments);
        }
      };
      wrapped.__wrappedForCrawler = true;
      window.fetch = wrapped;
    }
    // Wrap XHR
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR && !OrigXHR.prototype.__wrappedForCrawler) {
      const open = OrigXHR.prototype.open;
      const send = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function(method, url) {
        try { this.__crawlerInfo = { method: method || 'GET', url: url }; } catch {}
        return open.apply(this, arguments);
      };
      OrigXHR.prototype.send = function() {
        try {
          const info = this.__crawlerInfo || {};
          const baseUrl = location.href;
          this.addEventListener('loadend', () => {
            if (!deepMode) return;
            try { sendApi(info.url, info.method, this.status, baseUrl); } catch {}
          });
        } catch {}
        return send.apply(this, arguments);
      };
      OrigXHR.prototype.__wrappedForCrawler = true;
    }
  }

  function sendApi(url, method, status, baseUrl) {
    if (!enabled) return;
    if (!/^https?:/i.test(String(url))) return;
    safeSend({ type: 'bg:apiRequest', appId, url, method, status, baseUrl, ts: Date.now() });
  }

  // Overlay UI (in-page toggle)
  function createOverlay() {
    if (overlay) return;
    try {
      overlay = document.createElement('div');
      overlay.id = 'app-url-crawler-overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        left: '12px',
        bottom: '12px',
        zIndex: '2147483647',
        background: 'rgba(15,23,42,0.92)',
        color: '#e2e8f0',
        border: '1px solid #334155',
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        padding: '8px',
        font: '12px/1.4 system-ui, -apple-system, Segoe UI, Roboto',
        display: 'flex',
        gap: '6px',
        alignItems: 'center'
      });

      const title = document.createElement('span');
      title.textContent = 'Crawler';
      title.style.opacity = '0.8';

      const btn = document.createElement('button');
      btn.id = 'ac-toggle';
      Object.assign(btn.style, { cursor: 'pointer', padding: '4px 8px', borderRadius: '6px', border: '1px solid #334155', background: '#0b1220', color: '#e2e8f0' });
      btn.addEventListener('click', () => {
        if (enabled) {
          safeSend({ type: 'bg:pauseScan' });
        } else {
          safeSend({ type: 'bg:startScan', scopePath });
        }
      });

      const deepWrap = document.createElement('label');
      deepWrap.style.display = 'flex';
      deepWrap.style.alignItems = 'center';
      deepWrap.style.gap = '4px';
      const deepCb = document.createElement('input');
      deepCb.type = 'checkbox';
      deepCb.id = 'ac-deep';
      deepCb.addEventListener('change', async () => {
        // ensure appId
        try {
          if (!appId) {
            const res = await (runtime?.sendMessage?.({ type: 'bg:activeAppForTab' }) || Promise.resolve({ ok: false }));
            if (res?.ok && res.app?.appId) appId = res.app.appId;
          }
          if (appId) safeSend({ type: 'bg:updateSetting', appId, key: 'deepMode', value: !!deepCb.checked });
        } catch {}
      });
      const deepLbl = document.createElement('span'); deepLbl.textContent = 'deep'; deepLbl.style.opacity = '0.8';
      deepWrap.append(deepCb, deepLbl);

      const rescanBtn = document.createElement('button');
      rescanBtn.textContent = 'Rescan';
      Object.assign(rescanBtn.style, { cursor: 'pointer', padding: '4px 8px', borderRadius: '6px', border: '1px solid #334155', background: '#0b1220', color: '#e2e8f0' });
      rescanBtn.addEventListener('click', () => safeSend({ type: 'bg:rescanNow' }));

      overlay.append(title, btn, deepWrap, rescanBtn);
      document.documentElement.appendChild(overlay);

      function renderOverlay() {
        if (!overlay) return;
        const b = overlay.querySelector('#ac-toggle');
        const d = overlay.querySelector('#ac-deep');
        if (b) b.textContent = enabled ? 'On' : 'Off';
        if (d) d.checked = !!deepMode;
      }
      // Initial render + expose
      renderOverlay();
      overlay.__render = renderOverlay;
    } catch { /* ignore */ }
  }

  function updateOverlay() {
    if (!overlay) return;
    try { overlay.__render && overlay.__render(); } catch {}
  }

  function enable(newAppId, newScopePath, newDeepMode) {
    appId = newAppId; scopePath = newScopePath || '/'; deepMode = !!newDeepMode;
    if (enabled) return;
    enabled = true;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => extractLinksNow(), { once: true });
    } else {
      extractLinksNow();
    }
    window.addEventListener('load', () => extractLinksNow(), { once: true });
    installObserver();
    installHistoryHooks();
    installNetworkHooksOnce();
    updateOverlay();
  }

  function disable() {
    enabled = false;
    if (mo) { try { mo.disconnect(); } catch {} mo = null; }
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    pending.clear();
    updateOverlay();
  }

  runtime.onMessage?.addListener((msg, sender, sendResponse) => {
    try {
      if (msg?.type === 'cs:enable') { enable(msg.appId, msg.scopePath, msg.deepMode); sendResponse({ ok: true }); return; }
      if (msg?.type === 'cs:disable') { disable(); sendResponse({ ok: true }); return; }
      if (msg?.type === 'cs:extractNow') { extractLinksNow(); sendResponse({ ok: true }); return; }
      if (msg?.type === 'cs:setDeepMode') { deepMode = !!msg.deepMode; updateOverlay(); sendResponse({ ok: true }); return; }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  });

  // Create overlay early so Start/Rescan are accessible before enable()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createOverlay, { once: true });
  } else {
    createOverlay();
  }
})();
