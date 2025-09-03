import { normalizeScope } from './db.js';

const ASSET_EXT = new Set([
  'png','jpg','jpeg','gif','svg','webp','ico','bmp',
  'css','map','woff','woff2','ttf','otf','eot',
  'mp4','webm','mp3','wav','ogg','avi','mov',
  'pdf','zip','rar','7z','gz','bz2','dmg','exe','msi'
]);

export function inScope(app, href) {
  try {
    const u = new URL(href);
    const appUrl = new URL(app.origin + '/');
    if (u.origin !== appUrl.origin) return false;
    const scope = normalizeScope(app.scopePath || '/');
    return u.pathname.startsWith(scope);
  } catch {
    return false;
  }
}

export function classifyKind(href) {
  try {
    const u = new URL(href);
    const path = u.pathname.toLowerCase();
    const ext = (path.split('.').pop() || '').split('?')[0];
    if (ext && ASSET_EXT.has(ext)) return 'asset';
    // heuristic: /api/ or ends with .json treated as api
    if (path.includes('/api/') || path.endsWith('.json')) return 'api';
    return 'page';
  } catch {
    return 'page';
  }
}

