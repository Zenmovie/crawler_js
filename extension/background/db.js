/* IndexedDB wrapper for MV3 service worker.
 * Stores:
 *  - apps (keyPath: appId)
 *  - urls (keyPath: id autoIncrement)
 *      indexes: by_app (appId), by_app_canon ([appId, canonicalHref]) unique, by_app_kind ([appId, kind])
 */

const DB_NAME = 'app-url-crawler';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('apps')) {
        db.createObjectStore('apps', { keyPath: 'appId' });
      }
      if (!db.objectStoreNames.contains('urls')) {
        const urls = db.createObjectStore('urls', { keyPath: 'id', autoIncrement: true });
        urls.createIndex('by_app', 'appId', { unique: false });
        urls.createIndex('by_app_canon', ['appId', 'canonicalHref'], { unique: true });
        urls.createIndex('by_app_kind', ['appId', 'kind'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function withTx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = storeNames.map((n) => tx.objectStore(n));
    let done = false;
    tx.oncomplete = () => { if (!done) resolve(undefined); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    Promise.resolve(fn(...stores, tx)).then((val) => { done = true; resolve(val); }).catch(err => { try { tx.abort(); } catch {} reject(err); });
  });
}

export async function getApps() {
  return withTx(['apps'], 'readonly', (appsStore) => new Promise((resolve, reject) => {
    const req = appsStore.getAll();
    req.onsuccess = () => {
      const out = {};
      for (const a of req.result || []) out[a.appId] = a;
      resolve(out);
    };
    req.onerror = () => reject(req.error);
  }));
}

export async function getApp(appId) {
  return withTx(['apps'], 'readonly', (appsStore) => new Promise((resolve, reject) => {
    const req = appsStore.get(appId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

export async function saveApps(appsMap) {
  return withTx(['apps'], 'readwrite', async (appsStore) => {
    for (const app of Object.values(appsMap)) appsStore.put(app);
  });
}

export async function ensureApp({ origin, scopePath = '/' }) {
  const appId = buildAppId(origin, scopePath);
  let app = await getApp(appId);
  if (!app) {
    app = {
      appId,
      origin,
      scopePath,
      createdAt: Date.now(),
      lastScan: null,
      settings: {
        ignoreHash: true,
        excludeAssets: true,
        normalizeQuery: 'sort',
        maxUrls: 1000,
        deepMode: false,
      },
      counters: { total: 0, page: 0, api: 0, asset: 0 },
    };
    await withTx(['apps'], 'readwrite', (appsStore) => appsStore.put(app));
  }
  return app;
}

export function buildAppId(origin, scopePath = '/') {
  const sp = normalizeScope(scopePath);
  return `${origin}${sp}`;
}

export function normalizeScope(scopePath = '/') {
  try {
    if (!scopePath) return '/';
    let p = scopePath.trim();
    if (!p.startsWith('/')) p = `/${p}`;
    if (!p.endsWith('/')) p = `${p}/`;
    return p;
  } catch (e) {
    return '/';
  }
}

export async function updateApp(appId, patch) {
  const app = await getApp(appId);
  if (!app) return null;
  const updated = { ...app, ...patch };
  await withTx(['apps'], 'readwrite', (appsStore) => appsStore.put(updated));
  return updated;
}

export async function clearUrls(appId) {
  await withTx(['urls', 'apps'], 'readwrite', (urlsStore, appsStore) => new Promise((resolve, reject) => {
    const idx = urlsStore.index('by_app');
    const range = IDBKeyRange.only(appId);
    const req = idx.openCursor(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { urlsStore.delete(cur.primaryKey); cur.continue(); }
      else resolve();
    };
  })).catch(() => {});
  const app = await getApp(appId);
  if (app) {
    app.counters = { total: 0, page: 0, api: 0, asset: 0 };
    await withTx(['apps'], 'readwrite', (appsStore) => appsStore.put(app));
  }
}

export async function addOrUpdateUrlRecord(record) {
  const { appId, canonicalHref } = record;
  return withTx(['urls', 'apps'], 'readwrite', (urlsStore, appsStore) => new Promise((resolve, reject) => {
    const idx = urlsStore.index('by_app_canon');
    const getReq = idx.get([appId, canonicalHref]);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        // New record
        urlsStore.add(record);
        // Update counters
        const appReq = appsStore.get(appId);
        appReq.onerror = () => reject(appReq.error);
        appReq.onsuccess = () => {
          const app = appReq.result;
          if (app) {
            app.counters = app.counters || { total: 0, page: 0, api: 0, asset: 0 };
            app.counters.total += 1;
            if (record.kind && app.counters[record.kind] != null) app.counters[record.kind] += 1;
            appsStore.put(app);
          }
          resolve({ created: true, updated: false });
        };
      } else {
        // Merge and possibly adjust counters on kind change
        const priority = { api: 3, page: 2, asset: 1 };
        let newKind = existing.kind;
        if (record.kind && (priority[record.kind] || 0) > (priority[newKind] || 0)) newKind = record.kind;
        const merged = {
          ...existing,
          kind: newKind,
          method: record.method || existing.method || null,
          status: (record.status ?? existing.status ?? null),
          ts: record.ts || existing.ts || Date.now(),
          source: existing.source || record.source || null,
        };
        const kindChanged = merged.kind !== existing.kind;
        const putReq = urlsStore.put(merged);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => {
          if (!kindChanged) return resolve({ created: false, updated: true });
          const appReq = appsStore.get(appId);
          appReq.onerror = () => reject(appReq.error);
          appReq.onsuccess = () => {
            const app = appReq.result;
            if (app) {
              app.counters = app.counters || { total: 0, page: 0, api: 0, asset: 0 };
              if (existing.kind && app.counters[existing.kind] != null && app.counters[existing.kind] > 0) app.counters[existing.kind] -= 1;
              if (merged.kind && app.counters[merged.kind] != null) app.counters[merged.kind] += 1;
              appsStore.put(app);
            }
            resolve({ created: false, updated: true });
          };
        };
      }
    };
  }));
}

export async function listUrls(appId) {
  return withTx(['urls'], 'readonly', (urlsStore) => new Promise((resolve, reject) => {
    const idx = urlsStore.index('by_app');
    const req = idx.getAll(IDBKeyRange.only(appId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}
