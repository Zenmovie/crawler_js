# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2025-09-03

Added
- Chrome MV3 extension scaffold under `extension/` with popup and side panel
- IndexedDB storage (apps, urls) with unique `(appId, canonicalHref)`
- URL normalization: lowercase host, drop default ports, collapse slashes, strip index.html/php, sort query; ignore hash (option)
- Content script DOM scanner + SPA hooks (History/Navigation/Popstate)
- Deep mode (optional): intercept fetch/XHR (URL, method, status only)
- Popup UI: start/pause/rescan/reset, filters, copy/export, open side panel
- Side panel UI: full list, filters, per‑app settings, live updates
- BFS crawler: queue + visited counters, depth and rate controls, progress bar, queue preview, Skip/Skip N/Clear, Enqueue seed, Copy/Open next
- In‑page overlay: “Crawler On/Off”, “deep”, “Rescan”
- Build scripts and dual manifests (Chrome `manifest.json`, Firefox `manifest.firefox.json`)

Changed
- Robust messaging in content script to handle “Extension context invalidated”
- UI messages unified to English in side panel

## [0.1.0] - Initial
- In‑browser JS snippet (`js.txt`) proof of concept

