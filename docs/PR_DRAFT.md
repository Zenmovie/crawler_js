# App URL Crawler (MV3) — PR draft

Author: @lamerzen via privesc.ru

---

EN

## Summary

Extension that crawls in‑app URLs (DOM, SPA, navigation, optional API endpoints) and organizes them per “application” (origin+scope). Adds a side panel UI, IndexedDB storage, URL normalization, export, and a BFS crawler mode.

## What’s Included

- MV3 service worker background with messaging and orchestration
- Content script: DOM scanner, MutationObserver, SPA History/Navigation hooks
- Optional “Deep mode”: intercepts fetch/XHR (URL, method, status only)
- IndexedDB storage: apps + urls with unique (appId, canonicalHref)
- URL normalization & filters (ignore hash, sort query, strip index.html/php)
- Popup UI for quick control and export; side panel for full view
- BFS crawler: queue/visited counters, pacing, depth limit, live status, queue preview, skip/clear, enqueue seed, copy/open next
- Overlay on page: “Crawler On/Off”, “deep”, “Rescan”

## How to Test

1. Load unpacked from `extension/` (Chrome/Edge) or `manifest.firefox.json` (Firefox).
2. Open a target app page.
3. Popup → Start (enables content watchers). Optionally click “Side” to open side panel.
4. In side panel:
   - Toggle filters, deep mode, and per‑app settings (ignore hash, include assets, max URLs, query mode).
   - Start BFS: set Depth and Rate, then Start. Observe progress, visited/queued counters, queue preview.
   - Use Skip, Skip N, Clear queue, Enqueue seed, Copy next, Open next.
5. Overlay on the page: On/Off, deep, Rescan should reflect and control state.
6. Export: Copy/JSON/CSV should match filters and open in Excel/Sheets.

## Code Areas to Review

- Background orchestration & DB:
  - `extension/background/background.js`
  - `extension/background/db.js`
  - `extension/background/normalize.js`, `filters.js`
- Content script (robust messaging, SPA & deep mode):
  - `extension/content/content.js`
- UI
  - Popup: `extension/ui/popup.html|js|css`
  - Side panel: `extension/ui/sidepanel.html|js`

## Browser Support

- Chrome/Edge (Chromium): MV3 service worker, Side Panel API (optional)
- Firefox: MV3 with some differences; sidebar manifest provided

## Permissions

- `tabs`, `scripting`, `webNavigation`, `storage`, `clipboardWrite`, `unlimitedStorage`, `host_permissions: <all_urls>`

## Notes

- No request/response bodies stored in deep mode; only URL/method/status.
- BFS uses a single controlled tab and respects app scope.
- Service worker sleep is handled by session storage rehydration for BFS.

## Known Limitations

- No DevTools HAR mode yet (planned P3)
- BFS doesn’t simulate user clicks; it navigates programmatically and may miss auth‑gated flows.
- Firefox MV3 module workers may require adjustments depending on version.

## Screenshots (optional)

- Add `docs/overlay.png`, `docs/sidepanel.png` if desired.

---

RU

## Кратко

Расширение для сбора URL внутри веб‑приложений (DOM, SPA, навигация, опционально API‑эндпоинты) с группировкой по «приложениям» (origin+scope). Добавлены сайд‑панель, IndexedDB, нормализация URL, экспорт, BFS‑обход.

## Что входит

- MV3 service worker: оркестрация и обмен сообщениями
- Контент‑скрипт: DOM‑сканер, MutationObserver, хуки History/Navigation
- Deep mode (опция): перехват fetch/XHR (URL/метод/статус)
- IndexedDB: хранилище apps+urls, уникальный индекс `(appId, canonicalHref)`
- Нормализация/фильтры: ignore hash, сортировка query, срез index.html/php
- Popup для быстрых действий; полноценная сайд‑панель
- BFS: очередь/счётчики, лимит глубины, темп, лайв‑статус, превью очереди, Skip/Clear, Enqueue seed, Copy/Open next
- Overlay на странице: On/Off, deep, Rescan

## Как тестировать

1. Загрузите распакованное из `extension/` (Chrome/Edge) или `manifest.firefox.json` (Firefox).
2. Откройте нужное приложение.
3. В popup нажмите Start (включит слежение). По желанию — “Side” для сайд‑панели.
4. В сайд‑панели:
   - Включайте фильтры, deep, настраивайте per‑app (ignore hash, include assets, max URLs, query mode).
   - Запустите BFS: задайте Depth/Rate → Start. Смотрите прогресс, счётчики, превью очереди.
   - Используйте Skip, Skip N, Clear, Enqueue seed, Copy next, Open next.
5. Overlay на странице: On/Off, deep, Rescan должны отражать состояние и управлять сбором.
6. Экспорт: Copy/JSON/CSV должен соответствовать фильтрам; файлы открываются в Excel/Sheets.

## Что посмотреть в коде

- Фон/БД: `extension/background/background.js`, `db.js`, `normalize.js`, `filters.js`
- Контент: `extension/content/content.js`
- UI: popup (`extension/ui/popup.*`), side panel (`extension/ui/sidepanel.*`)

## Браузеры

- Chrome/Edge (Chromium): MV3, Side Panel API (опционально)
- Firefox: MV3 с отличиями; предоставлен sidebar‑манифест

## Права

- `tabs`, `scripting`, `webNavigation`, `storage`, `clipboardWrite`, `unlimitedStorage`, `host_permissions: <all_urls>`

## Заметки

- Deep mode не пишет тела/заголовки — только URL/метод/статус.
- BFS ходит в одном табе и уважает скоуп приложения.
- Сон service worker закрыт ре‑гидрацией состояния BFS из session storage.

## Ограничения

- Нет DevTools‑HAR (план P3)
- BFS не нажимает кнопки, может не пройти auth‑флоу
- MV3‑модули в Firefox зависят от версии

## Скриншоты (опц.)

- Можно добавить `docs/overlay.png`, `docs/sidepanel.png`.

---

Credits: @lamerzen via privesc.ru
