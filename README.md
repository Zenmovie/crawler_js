# crawler_js
inbrowser link crawler from js


![](./usage.gif)

# Быстрое создание браузерных расширений для пентест‑задач (Chrome MV3 / Firefox)

Материал: краткое дополнение к посту [«Linkfinder в браузере»](https://telegra.ph/Linkfinder-v-zakladke-09-03). Идея — переносить привычные находилки/сканеры ссылок прямо в браузер: DOM‑скан, SPA‑навигация, простая «сеть» (fetch/XHR), BFS‑обход. Всё локально и под контролем пользователя.

Авторство: @lamerzen via privesc.ru

## Зачем переносить утилиты в браузер
- Ближе к реальной среде приложения: DOM, SPA‑роутинг, клиентские редиректы, History/Navigation API.
- Минимальная установка: «загрузить распакованное» → сразу работает.
- Никаких внешних серверов: локальные хранилища, явные разрешения.

## Архитектура в двух словах
- Chrome (Manifest V3):
  - background.service_worker (эвент‑драйв), messaging, orchestration.
  - content script: инъекция в вкладку, доступ к DOM/History/Fetch/XHR.
  - action: popup; side_panel (Chrome 114+).
  - storage: chrome.storage.local / IndexedDB.
- Firefox (WebExtensions MV3):
  - Похожая модель; для боковой панели — `sidebar_action` (у Chrome — `side_panel`).
  - Поддержка MV3 развивается; при необходимости — отдельный manifest для FF.

## Структура (граф файлов) и ответственность компонентов
```
extension/
  manifest.json                # Chrome MV3
  manifest.firefox.json        # Firefox MV3 (sidebar_action)
  background/
    background.js              # Оркестрация: сообщения, webNavigation, BFS, лимиты
    db.js                      # IndexedDB слой: apps/urls, индексы, upsert
    normalize.js               # Каноникализация URL (хост, порт, index.html, query)
    filters.js                 # Скоуп, классификация page/api/asset
  content/
    content.js                 # DOM‑скан, MutationObserver, History/Navigation, fetch/XHR, overlay
  ui/
    popup.html|js|css          # Быстрые действия: Start/Pause/Rescan/Export
    sidepanel.html|js          # Полноценный UI: фильтры, настройки, BFS, прогресс
scripts/
  build.sh                     # Создание Chrome/Firefox ZIP, версия из manifest
```
Ключевые сообщения: `bg:*` (фон), `cs:*` (контент), `ui:*` (оповещения UI). Хранилище — IndexedDB (дедуп по `(appId, canonicalHref)`).

## Мини‑гайд: сделать своё расширение
1) Создайте `manifest.json` (MV3)
```
{
  "manifest_version": 3,
  "name": "My Crawler",
  "version": "0.1.0",
  "permissions": ["tabs", "scripting", "webNavigation", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" }
}
```
2) Добавьте `background.js`: слушатели `chrome.runtime.onMessage`, `webNavigation.*`, инъекция контента с `chrome.scripting.executeScript`.

3) Добавьте `content.js`: сбор ссылок из DOM/атрибутов, `MutationObserver`, хуки History API; отправляйте найденное через `runtime.sendMessage`.

4) Popup/Side panel: HTML+JS для управления, фильтров, экспорта; запрашивайте из background список URL.

5) Дедуп/нормализация: храните `canonicalHref`; приводите хост к нижнему регистру, убирайте дефолтные порты/`index.html`, сортируйте query.

6) Firefox: либо общий манифест, либо отдельный `manifest.firefox.json` (+`sidebar_action`). Загружайте временно через `about:debugging`.

7) Сборка/загрузка: Chrome — `chrome://extensions` → «Загрузить распакованное». Сборка ZIP: `zip -r out.zip extension/` или `scripts/build.sh`.

## Портирование CLI‑утилит в браузер (принципы)
- Без «сырых» сокетов и exec. Используйте доступное: DOM, навигация, fetch/XHR, devtools (опционально).
- Для «linkfinder»: парс DOM, ловите SPA‑роуты, дополняйте перехватом fetch/XHR (только URL/метод/статус, без тел).
- Для обхода: однопоточный BFS через `tabs.update()` + `webNavigation` + окно сбора ссылок.
- Учитывайте: SOP/CORS, сон service worker (ре‑гидрация состояния в `storage.session`).

## Из чего состоит наш вариант
- Источники URL: DOM/Mutation, webNavigation, SPA (History/Navigation), deep mode fetch/XHR.
- Хранилище: IndexedDB с дедупом; экспорт Copy/JSON/CSV.
- UI: popup (быстро), side panel (полный), overlay (On/Off, deep, Rescan).
- BFS: глубина, темп, очередь/visited, skip/clear/skip N, enqueue seed, copy/open next.
- Политика: локально, без отправки наружу; `host_permissions` по `<all_urls>`.

## Безопасность и право
- Использовать только на ресурсах, где у вас есть разрешение. Не перехватывайте и не сохраняйте чувствительные тела запросов/ответов.

## Полезные ссылки
- Chrome MV3: https://developer.chrome.com/docs/extensions/mv3/
- Firefox WebExtensions: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions
- Side Panel API (Chrome): https://developer.chrome.com/docs/extensions/reference/sidePanel
- Storage/IndexedDB: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API

---
Credits: t.me/lamerzen via privesc.ru

inspired by https://github.com/sinaayeganeh/Find-Hidden-Endpoint
