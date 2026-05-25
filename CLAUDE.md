# Loki — Server Log Viewer

Desktop app для читання server логів pharmbase. Написано на Electron + чистий JS/HTML/CSS.

## Запуск

```bash
cd "C:\Proxima\playwright repo\log-viewer-app"
npm install        # один раз
npm start          # запустити аппку
npm run build      # зібрати Loki.exe для колег (dist/)
```

## Структура

```
log-viewer-app/
├── main.js          ← Electron main process: вікно, меню, IPC, fs.watch
├── preload.js       ← Bridge між renderer і Node.js (contextBridge)
├── index.html       ← Поточний UI (простий viewer)
├── package.json
└── src/             ← Нові фічі (локально, ще не в репо)
    ├── index.html
    ├── style.css
    ├── parser.js       ← parseLines(), extractJsonBlocks()
    ├── json-viewer.js  ← Collapsible JSON + diff
    └── app.js          ← Virtual scroll, фільтри, сортування
```

## Що вміє (поточна версія в репо)

- Відкрити .log файл через кнопку або drag & drop
- **Virtual scroll** — рендерить тільки ~120 видимих рядків з тисяч
- **Фільтри**: INFO / ERROR / DEBUG / WARN + HTTP / SLAVE / BUS / OTHER
  - Клік на рівень = solo режим (показує тільки цей рівень)
  - Повторний клік = повертає всі
- **Trace filter**: клік на trace ID → фільтрує тільки цей трейс
- **Пошук**: текст або `/regex/`
- **JSON beautify**: клік на рядок → detail panel з підсвіченим JSON
  - Nested stringified JSON теж парситься рекурсивно
- **Copy** кнопка в detail
- **Live reload** через `fs.watch` (Node.js, не поллінг)
- Клавіші: `j`/`k` навігація, `Enter` розгорнути, `Esc` закрити/зняти фільтр
- Меню Help → відкриває папку з логами

## Формат логів

```
2026/05/25 08:24:08 INFO #0177e592-f70e-44fb-a99a-cd21e04f00e5: HTTP << Request POST https://... {"body":...}
```

Поля: `дата час РІВЕНЬ #traceId: КОМПОНЕНТ НАПРЯМ тіло`

Компоненти: `HTTP`, `SLAVE`, `BUS`
Напрямки: `<<` (вхідний), `>>` (вихідний), `<`, `>`

## Нові фічі (в src/, ще не запушені)

1. **Split pane** — список зліва, detail panel справа, drag-to-resize
2. **Collapsible JSON** — ▾/▸ клік на будь-який `{...}` або `[...]`
3. **Expand/Collapse all** — кнопки ⊞/⊟
4. **Пошук в body** — підсвічує матчі в JSON view
5. **Сортування** — клік по заголовку колонки (Час/Рівень/Comp)
6. **JSON Diff** — 📌 Pin рядок A, вибери рядок B → вкладка Diff

Щоб переключитись на нові фічі — в `main.js` змінити:
```js
mainWindow.loadFile(path.join(__dirname, 'index.html'));
// на:
mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
```

## Білд .exe

```bash
npm run build
# → dist/Loki 1.0.0.exe (~68MB, portable, без інсталяції)
```

Збілд вимагає прав на symlinks або запуску від адміна (через winCodeSign).
Якщо помилка symlink — білд все одно може завершитись успішно для `portable` target.

## Де логи сервера

```
C:\Proxima\preprod\win64\server\log\server\primary\
```

## Репо

https://github.com/IhorDvorkovyiP/Loki
