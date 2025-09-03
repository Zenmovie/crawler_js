// URL normalization utilities

export function toAbsoluteUrl(href, base) {
  try {
    if (!href) return null;
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

export function canonicalize(href, { ignoreHash = true, normalizeQuery = 'sort', stripIndexHtml = true } = {}) {
  try {
    const u = new URL(href);
    u.username = '';
    u.password = '';
    // lowercase host
    u.hostname = u.hostname.toLowerCase();
    // drop default ports
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    // collapse duplicate slashes in path
    u.pathname = u.pathname.replace(/\/+/g, '/');
    // ensure leading slash
    if (!u.pathname.startsWith('/')) u.pathname = `/${u.pathname}`;
    // strip index.html or index.htm/php
    if (stripIndexHtml) {
      if (/\/index\.(html?|php)$/i.test(u.pathname)) {
        u.pathname = u.pathname.replace(/\/index\.(html?|php)$/i, '/');
      }
    }
    // normalize query: sort params deterministically
    if (normalizeQuery === 'sort' && u.search) {
      const sp = new URLSearchParams(u.search);
      const entries = Array.from(sp.entries());
      entries.sort(([aK, aV], [bK, bV]) => aK === bK ? (aV < bV ? -1 : aV > bV ? 1 : 0) : (aK < bK ? -1 : 1));
      const sp2 = new URLSearchParams();
      for (const [k, v] of entries) sp2.append(k, v);
      const s = sp2.toString();
      u.search = s ? `?${s}` : '';
    }
    // optional: drop hash
    if (ignoreHash) u.hash = '';
    return u.toString();
  } catch (e) {
    return href;
  }
}

export function getOrigin(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
