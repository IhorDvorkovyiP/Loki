import { parseLines } from './parser.js';
import { renderJsonFromRaw, setAllCollapsed, highlightSearch } from './json-viewer.js';

// ── Constants ────────────────────────────────────────────────────────────
let ROW_H    = 22;   // mutable — змінюється у wrap mode
const BUFFER = 60;

// ── State ────────────────────────────────────────────────────────────────
let allLines      = [];
let filteredLines = [];
let activeLevels  = new Set(['INFO', 'ERROR', 'WARN']);
let activeComps   = new Set(['HTTP', 'SLAVE', 'BUS', 'FRONT', 'MASTER', 'OTHER']);
let searchQuery   = '';
let searchRe      = null;
let highlightedTrace = '';   // підсвічений trace (не фільтрує, тільки колір)
let selectedIdx   = -1;      // index into filteredLines
let bodySearchQuery = '';
let rowTops       = [];
let totalH        = 0;
let currentFilePath = null;
let liveMode      = false;
let rafId         = null;
let savedLines      = [];
let showingSaved    = false;
let savedActiveIdx  = 0;

// Solo-mode tracking for filter buttons
let soloLevel = null;
let soloComp  = null;

// Row selection (Ctrl+click / Shift+click)
let selectedLineIds  = new Set();  // set of line.idx
let showOnlySelected = false;
let lastClickFiltIdx = -1;         // for Shift+click range selection

// Exclusion filter
let excludeTerms = []; // array of strings to exclude

// Bookmarks
let bookmarkedLineIds = new Set();
let searchNavIdx = 0;   // поточна позиція F3-навігації у filteredLines

// Wrap mode
let wrapMode   = false;
let rowHeights = []; // per-row heights in wrap mode (empty otherwise)

// Column lock
let colsLocked = false;

// Font size
let fontSize = 12.5; // px
const FONT_MIN = 9, FONT_MAX = 20;

// File tabs
let tabs        = [];
let activeTabId = 0;
let _tabCtr     = 0;

// Recent files
const RECENT_KEY = 'loki-recent';

// Column visibility
const colVisible = { time: true, level: true, trace: true, comp: true, dir: true };
const COL_LABELS = { time: 'Час', level: 'Рівень', trace: 'Trace', comp: 'Comp', dir: 'Dir' };

// ── DOM refs ─────────────────────────────────────────────────────────────
const logContainer   = document.getElementById('log-container');
const vsSpacer       = document.getElementById('vs-spacer');
const detailMeta     = document.getElementById('detail-meta');
const detailContent  = document.getElementById('detail-content');
const statsEl        = document.getElementById('stats');
const traceBar       = document.getElementById('trace-bar');
const traceVal       = document.getElementById('trace-val');
const dropZone       = document.getElementById('drop-zone');
const workspace      = document.getElementById('workspace');
const searchInput    = document.getElementById('search');
const bodySearch     = document.getElementById('body-search');
const openBtn        = document.getElementById('open-btn');
const liveBtn        = document.getElementById('live-btn');
const expandAllBtn   = document.getElementById('expand-all-btn');
const collapseAllBtn = document.getElementById('collapse-all-btn');
const traceClear     = document.getElementById('trace-clear');
const listPane       = document.getElementById('list-pane');
const resizeHandle   = document.getElementById('resize-handle');
const saveBtn        = document.getElementById('save-btn');
const savedTabBtn    = document.getElementById('saved-tab-btn');
const savedCountEl   = document.getElementById('saved-count');
const savedPane      = document.getElementById('saved-pane');
const detailView     = document.getElementById('detail-view');
const copyJsonBtn    = document.getElementById('copy-json-btn');
const copyRawBtn     = document.getElementById('copy-raw-btn');
const detailPane     = document.getElementById('detail-pane');
const detailToggleBtn = document.getElementById('detail-toggle-btn');
let detailCollapsed  = false;
const selectionBar   = document.getElementById('selection-bar');
const selectionCountEl = document.getElementById('selection-count');
const showSelectedBtn  = document.getElementById('show-selected-btn');
const exportSelectedBtn = document.getElementById('export-selected-btn');
const clearSelectionBtn = document.getElementById('clear-selection-btn');
const recentBtn         = document.getElementById('recent-btn');
const wrapBtn           = document.getElementById('wrap-btn');

// ── Filtering ────────────────────────────────────────────────────────────

function buildSearchRe(q) {
  if (!q) return null;
  const m = q.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) {
    try { return new RegExp(m[1], m[2] || 'i'); } catch (_) { return null; }
  }
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function matchesSearch(line) {
  if (!searchRe) return true;
  return searchRe.test(line.raw);
}

// ── Dynamic row height (wrap mode) ───────────────────────────────────────

function computeRowHeight(line) {
  if (!wrapMode) return ROW_H;
  // Estimate how many lines the body needs
  // Fixed columns (time+level+trace+comp+dir) ≈ 390px; body gets the rest
  const bodyWidth = Math.max(100, (listPane.offsetWidth || 900) - 390);
  const charW     = fontSize * 0.605; // approx monospace char width
  const cpp       = Math.max(10, Math.floor(bodyWidth / charW)); // chars per line
  const bodyLen   = (line.body || '').length;
  const lines     = Math.max(1, Math.ceil(bodyLen / cpp));
  const lineH     = Math.ceil(fontSize * 1.5);
  return lines * lineH + 10; // 10px padding top+bottom
}

function recomputeRowTops() {
  if (wrapMode) {
    rowHeights = filteredLines.map(l => computeRowHeight(l));
    let top = 0;
    rowTops = rowHeights.map(h => { const t = top; top += h; return t; });
    totalH  = top;
  } else {
    rowHeights = [];
    rowTops = filteredLines.map((_, i) => i * ROW_H);
    totalH  = filteredLines.length * ROW_H;
  }
  vsSpacer.style.height = totalH + 'px';
}

function recomputeFiltered() {
  const excLower = excludeTerms.map(t => t.toLowerCase());
  filteredLines = allLines.filter(l =>
    activeLevels.has(l.level) &&
    activeComps.has(l.comp) &&
    matchesSearch(l) &&
    (!showOnlySelected || selectedLineIds.has(l.idx)) &&
    (excLower.length === 0 || !excLower.some(t => l.raw.toLowerCase().includes(t)))
  );

  recomputeRowTops();
  statsEl.textContent = `${filteredLines.length} / ${allLines.length} рядків`;
  updateSearchCount();
}

function updateSearchCount() {
  const el = document.getElementById('search-count');
  if (!el) return;
  if (!searchQuery) { el.textContent = ''; el.className = ''; return; }
  const n = filteredLines.length;
  if (n === 0) {
    el.textContent = 'не знайдено';
    el.className = 'no-results';
  } else {
    const pos = searchNavIdx >= 0 && searchNavIdx < n ? ` · ${searchNavIdx + 1}/${n}` : ` · ${n}`;
    el.textContent = `${n} збігів${pos}`;
    el.className = 'has-results';
  }
}

function navigateSearch(dir) {
  if (!filteredLines.length) return;
  searchNavIdx = ((searchNavIdx + dir) + filteredLines.length) % filteredLines.length;
  selectedIdx = searchNavIdx;
  refreshSelectedClass();
  showDetail(filteredLines[searchNavIdx]);
  // Scroll to match
  const rowTop = rowTops[searchNavIdx];
  if (rowTop < logContainer.scrollTop)
    logContainer.scrollTop = rowTop;
  if (rowTop + ROW_H > logContainer.scrollTop + logContainer.clientHeight)
    logContainer.scrollTop = rowTop + ROW_H - logContainer.clientHeight;
  updateSearchCount();
}

// ── Virtual scroll ────────────────────────────────────────────────────────

function scheduleRender() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(renderVisible);
}

function binarySearchStart(scrollTop) {
  let lo = 0, hi = filteredLines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowTops[mid] + ROW_H < scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

let renderedRows = new Map(); // filteredIdx → DOM element

function renderVisible() {
  rafId = null;
  const scrollTop    = logContainer.scrollTop;
  const clientHeight = logContainer.clientHeight;
  const start = Math.max(0, binarySearchStart(scrollTop) - BUFFER);
  // In wrap mode rows have variable heights; find the last visible row properly
  let end;
  if (wrapMode && rowHeights.length) {
    const viewEnd = scrollTop + clientHeight;
    let e = start;
    while (e < filteredLines.length - 1 && rowTops[e] + rowHeights[e] < viewEnd) e++;
    end = Math.min(filteredLines.length - 1, e + BUFFER);
  } else {
    end = Math.min(filteredLines.length - 1,
      Math.ceil((scrollTop + clientHeight) / ROW_H) + BUFFER);
  }

  for (const [idx, rowEl] of renderedRows) {
    if (idx < start || idx > end) {
      rowEl.remove();
      renderedRows.delete(idx);
    }
  }

  for (let i = start; i <= end; i++) {
    if (renderedRows.has(i)) continue;
    const line = filteredLines[i];
    const rowEl = buildRow(line, i);
    vsSpacer.appendChild(rowEl);
    renderedRows.set(i, rowEl);
  }
}

function buildRow(line, filtIdx) {
  const row = document.createElement('div');
  row.className = `log-line level-${line.level}`;
  if (filtIdx === selectedIdx) row.classList.add('selected');
  if (selectedLineIds.has(line.idx)) row.classList.add('row-selected');
  if (highlightedTrace && line.trace === highlightedTrace) row.classList.add('trace-highlighted');
  if (bookmarkedLineIds.has(line.idx)) row.classList.add('bookmarked');
  row.style.top = rowTops[filtIdx] + 'px';
  if (wrapMode && rowHeights.length > filtIdx) {
    row.style.height = rowHeights[filtIdx] + 'px';
  }

  const tTime  = document.createElement('span'); tTime.className  = 'col-time';  tTime.textContent  = line.time;
  const tLevel = document.createElement('span'); tLevel.className = 'col-level'; tLevel.textContent = line.level;
  const tTrace = document.createElement('span'); tTrace.className = 'col-trace'; tTrace.textContent = line.trace;
  const tComp  = document.createElement('span'); tComp.className  = 'col-comp';  tComp.textContent  = line.comp;
  const tDir   = document.createElement('span'); tDir.className   = 'col-dir';   tDir.textContent   = line.dir;
  const tBody  = document.createElement('span'); tBody.className  = 'col-body';  tBody.textContent  = wrapMode ? (line.body || '') : firstLine(line.body);

  row.appendChild(tTime);
  row.appendChild(tLevel);
  row.appendChild(tTrace);
  row.appendChild(tComp);
  row.appendChild(tDir);
  row.appendChild(tBody);

  // Preserve focus on search/bodySearch inputs while clicking rows
  row.addEventListener('mousedown', (e) => {
    const active = document.activeElement;
    if (active === searchInput || active === bodySearch) e.preventDefault();
  });

  row.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click = toggle individual row selection
      if (selectedLineIds.has(line.idx)) selectedLineIds.delete(line.idx);
      else selectedLineIds.add(line.idx);
      row.classList.toggle('row-selected', selectedLineIds.has(line.idx));
      lastClickFiltIdx = filtIdx;
      updateSelectionBar();
      return;
    }
    if (e.shiftKey && lastClickFiltIdx !== -1) {
      // Shift+click = select range
      const lo = Math.min(filtIdx, lastClickFiltIdx);
      const hi = Math.max(filtIdx, lastClickFiltIdx);
      for (let i = lo; i <= hi; i++) {
        if (filteredLines[i]) selectedLineIds.add(filteredLines[i].idx);
      }
      updateSelectionBar();
      refreshSelectedClass();
      return;
    }
    lastClickFiltIdx = filtIdx;
    selectedIdx = filtIdx;
    refreshSelectedClass();
    showDetail(line);
  });

  tTrace.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!line.trace) return;
    if (highlightedTrace === line.trace) {
      clearTraceHighlight();
    } else {
      setTraceHighlight(line.trace);
    }
  });

  return row;
}

function firstLine(str) {
  return str ? str.split('\n')[0] : '';
}

function refreshSelectedClass() {
  for (const [idx, rowEl] of renderedRows) {
    const line = filteredLines[idx];
    rowEl.classList.toggle('selected', idx === selectedIdx);
    if (line) {
      rowEl.classList.toggle('row-selected', selectedLineIds.has(line.idx));
      rowEl.classList.toggle('trace-highlighted', !!highlightedTrace && line.trace === highlightedTrace);
      rowEl.classList.toggle('bookmarked', bookmarkedLineIds.has(line.idx));
    }
  }
}

function clearRendered() {
  for (const rowEl of renderedRows.values()) rowEl.remove();
  renderedRows.clear();
}

// ── Detail pane ───────────────────────────────────────────────────────────

function showDetail(line) {
  if (!line) {
    detailMeta.innerHTML = '';
    detailContent.innerHTML = '';
    return;
  }

  updateSaveBtn(line);
  if (showingSaved) showDetailView();

  detailMeta.innerHTML = '';
  const metaB = document.createElement('b');
  metaB.textContent = line.time + '  ';
  detailMeta.appendChild(metaB);
  detailMeta.appendChild(document.createTextNode(
    [line.trace, line.comp, line.dir].filter(Boolean).join('  ')
  ));

  detailContent.innerHTML = '';
  const dom = renderJsonFromRaw(line.raw, { sorted: true });
  detailContent.appendChild(dom);

  // Завжди читаємо з поля, а не зі stale-змінної
  const bq = bodySearch.value.trim();
  if (bq) highlightSearch(detailContent, bq);
}

function currentLine() {
  if (selectedIdx < 0 || selectedIdx >= filteredLines.length) return null;
  return filteredLines[selectedIdx];
}

// ── Trace filter ──────────────────────────────────────────────────────────

function setTraceHighlight(trace) {
  highlightedTrace = trace;
  traceVal.textContent = trace;
  traceBar.classList.add('show');
  clearRendered();
  scheduleRender();
}

function clearTraceHighlight() {
  highlightedTrace = '';
  traceBar.classList.remove('show');
  clearRendered();
  scheduleRender();
}

// ── File loading ──────────────────────────────────────────────────────────

function loadText(text, filePath) {
  allLines = parseLines(text);
  currentFilePath = filePath || null;
  selectedIdx = -1;
  detailMeta.innerHTML = '';
  detailContent.innerHTML = '';
  highlightedTrace = '';
  traceBar.classList.remove('show');
  bookmarkedLineIds = new Set();
  computeColWidths();
  loadColWidths(); // user-saved widths override auto-computed
  recomputeFiltered();
  clearRendered();
  scheduleRender();
  showWorkspace();
  // Update active tab label + recent list
  const _t = tabs.find(t => t.id === activeTabId);
  if (_t) {
    _t.label    = filePath ? filePath.split(/[\\/]/).pop() : 'Log';
    _t.filePath = currentFilePath;
    updateTabBar();
  }
  addToRecent(filePath);
  // Auto-enable live mode for plain text files (not gz/zip entries)
  const ext = filePath ? filePath.split('.').pop().toLowerCase() : '';
  if (filePath && ext !== 'gz' && ext !== 'zip' && window.electronAPI) {
    setLiveMode(true);
  }
}

// Live reload — перечитує файл але зберігає фільтри, trace, selected
// Повне перезавантаження (ротація файлу або gz)
function liveReload(text) {
  const wasAtBottom = logContainer.scrollTop + logContainer.clientHeight >= totalH - ROW_H * 3;
  allLines = parseLines(text);
  computeColWidths();
  recomputeFiltered();
  clearRendered();
  scheduleRender();
  if (selectedIdx >= filteredLines.length) {
    selectedIdx = -1;
    detailMeta.innerHTML = '';
    detailContent.innerHTML = '';
  }
  if (wasAtBottom) logContainer.scrollTop = totalH;
}

// Incremental append — тільки нові рядки (швидко!)
function liveAppend(newText) {
  const wasAtBottom = logContainer.scrollTop + logContainer.clientHeight >= totalH - ROW_H * 3;

  const newLines = parseLines(newText);
  if (!newLines.length) return;

  // Продовжуємо idx з кінця allLines
  const nextIdx = allLines.length > 0 ? allLines[allLines.length - 1].idx + 1 : 0;
  newLines.forEach((l, i) => { l.idx = nextIdx + i; });

  allLines = allLines.concat(newLines);

  // Додаємо нові рядки у filteredLines якщо вони відповідають фільтру
  const excLower = excludeTerms.map(t => t.toLowerCase());
  const toAdd = newLines.filter(l =>
    activeLevels.has(l.level) &&
    activeComps.has(l.comp) &&
    matchesSearch(l) &&
    (!showOnlySelected || selectedLineIds.has(l.idx)) &&
    (excLower.length === 0 || !excLower.some(t => l.raw.toLowerCase().includes(t)))
  );

  if (toAdd.length) {
    filteredLines = filteredLines.concat(toAdd);
    recomputeRowTops();
    statsEl.textContent = `${filteredLines.length} / ${allLines.length} рядків`;
    scheduleRender();
  } else {
    statsEl.textContent = `${filteredLines.length} / ${allLines.length} рядків`;
  }

  if (wasAtBottom) logContainer.scrollTop = totalH;
}

function showWorkspace() {
  dropZone.classList.remove('visible');
  workspace.style.display = 'flex';
}

async function openFileDialog() {
  if (window.electronAPI) {
    const filePath = await window.electronAPI.openFile();
    if (!filePath) return;
    await openByPath(filePath);
  } else {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Log files', accept: { 'text/plain': ['.log', '.txt', '.gz'] } }],
      });
      const file = await handle.getFile();
      if (file.name.toLowerCase().endsWith('.gz')) {
        const buf = await file.arrayBuffer();
        const text = await decompressGzBrowser(buf);
        loadText(text, file.name);
      } else {
        const text = await file.text();
        loadText(text, file.name);
      }
    } catch (_) {}
  }
}

// Route a file path to the right loader (plain / gz / zip)
async function openByPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  if (ext === 'zip') {
    await openZipFile(filePath);
  } else {
    // .gz is handled transparently in main.js via zlib.gunzip
    const text = await window.electronAPI.readFile(filePath);
    loadText(text, filePath);
  }
}

// Open a ZIP: one file → direct open; many → show picker
async function openZipFile(filePath) {
  let entries;
  try { entries = await window.electronAPI.listZip(filePath); } catch (e) {
    console.error('listZip error', e);
    return;
  }
  if (!entries || !entries.length) {
    showZipPicker(filePath, [], 'У ZIP архіві не знайдено лог-файлів');
    return;
  }
  if (entries.length === 1) {
    const text = await window.electronAPI.readZipEntry(filePath, entries[0]);
    loadText(text, null); // null = no live watching for zip entries
    return;
  }
  showZipPicker(filePath, entries);
}

// Modal that lists files inside a ZIP
function showZipPicker(filePath, entries, errorMsg) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const modal = document.createElement('div');
  modal.style.cssText = [
    'background:#252526;border:1px solid #3c3c3c;border-radius:6px;',
    'padding:20px 20px 16px;min-width:380px;max-width:600px;',
    'max-height:75vh;display:flex;flex-direction:column;gap:10px;',
  ].join('');

  const title = document.createElement('div');
  title.style.cssText = 'font-size:13px;font-weight:bold;color:#ccc;flex-shrink:0;';
  title.textContent = '📦 ' + filePath.split(/[\\/]/).pop();
  modal.appendChild(title);

  if (errorMsg) {
    const msg = document.createElement('div');
    msg.style.cssText = 'color:#888;font-size:12px;padding:8px 0;';
    msg.textContent = errorMsg;
    modal.appendChild(msg);
  } else {
    const hint = document.createElement('div');
    hint.style.cssText = 'color:#666;font-size:11px;flex-shrink:0;';
    hint.textContent = 'Оберіть файл для відкриття:';
    modal.appendChild(hint);

    const list = document.createElement('div');
    list.style.cssText = 'overflow-y:auto;display:flex;flex-direction:column;gap:3px;';

    for (const entry of entries) {
      const btn = document.createElement('button');
      btn.style.cssText = [
        'background:#2d2d2d;border:1px solid #444;color:#d4d4d4;',
        'padding:7px 12px;text-align:left;border-radius:3px;cursor:pointer;',
        'font-family:inherit;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      ].join('');
      btn.title = entry;
      btn.textContent = '📄 ' + entry;
      btn.addEventListener('mouseenter', () => { btn.style.background = '#3c3c3c'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = '#2d2d2d'; });
      btn.addEventListener('click', async () => {
        overlay.remove();
        try {
          const text = await window.electronAPI.readZipEntry(filePath, entry);
          loadText(text, null); // null = no live watching for zip entries
        } catch (e) { console.error('readZipEntry error', e); }
      });
      list.appendChild(btn);
    }
    modal.appendChild(list);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = [
    'background:transparent;border:1px solid #555;color:#888;',
    'padding:5px 16px;border-radius:3px;cursor:pointer;font-family:inherit;',
    'align-self:flex-end;flex-shrink:0;',
  ].join('');
  cancelBtn.textContent = 'Скасувати';
  cancelBtn.addEventListener('click', () => overlay.remove());
  modal.appendChild(cancelBtn);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// Browser-side .gz decompress (used when no Electron API)
async function decompressGzBrowser(arrayBuffer) {
  try {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(arrayBuffer));
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  } catch (e) {
    throw new Error('Не вдалося розпакувати .gz: ' + e.message);
  }
}

// ── Live mode ─────────────────────────────────────────────────────────────

function setLiveMode(on) {
  liveMode = on;
  // Завжди знімаємо попередній watcher перед тим як поставити новий
  if (window.electronAPI) window.electronAPI.unwatchFile();

  if (on) {
    liveBtn.classList.add('live-on');
    liveBtn.textContent = '⟳ Live ON';
    if (currentFilePath && window.electronAPI) {
      window.electronAPI.watchFile(
        currentFilePath,
        (fullText) => liveReload(fullText),   // file-changed (ротація)
        (newChunk) => liveAppend(newChunk)    // file-appended (incremental)
      );
    }
  } else {
    liveBtn.classList.remove('live-on');
    liveBtn.textContent = '⟳ Live';
  }
}

// ── Filter buttons ────────────────────────────────────────────────────────

function handleLevelToggle(btn) {
  const lvl = btn.dataset.level;
  if (soloLevel === lvl) {
    activeLevels = new Set(['INFO', 'ERROR', 'WARN']);
    soloLevel = null;
    document.querySelectorAll('.toggle-btn[data-level]').forEach(b => b.classList.add('active'));
  } else if (activeLevels.size === 3 || soloLevel) {
    activeLevels = new Set([lvl]);
    soloLevel = lvl;
    document.querySelectorAll('.toggle-btn[data-level]').forEach(b => {
      b.classList.toggle('active', b.dataset.level === lvl);
    });
  } else {
    if (activeLevels.has(lvl)) { activeLevels.delete(lvl); btn.classList.remove('active'); }
    else                        { activeLevels.add(lvl);    btn.classList.add('active');    }
  }
  recomputeFiltered();
  clearRendered();
  scheduleRender();
}

const ALL_COMPS = ['HTTP', 'SLAVE', 'BUS', 'FRONT', 'MASTER', 'OTHER'];

function handleCompToggle(btn) {
  const comp = btn.dataset.comp;
  if (soloComp === comp) {
    activeComps = new Set(ALL_COMPS);
    soloComp = null;
    document.querySelectorAll('.toggle-btn[data-comp]').forEach(b => b.classList.add('active'));
  } else if (activeComps.size === ALL_COMPS.length || soloComp) {
    activeComps = new Set([comp]);
    soloComp = comp;
    document.querySelectorAll('.toggle-btn[data-comp]').forEach(b => {
      b.classList.toggle('active', b.dataset.comp === comp);
    });
  } else {
    if (activeComps.has(comp)) { activeComps.delete(comp); btn.classList.remove('active'); }
    else                        { activeComps.add(comp);    btn.classList.add('active');    }
  }
  recomputeFiltered();
  clearRendered();
  scheduleRender();
}

// ── Resize handle ─────────────────────────────────────────────────────────

function initResizeHandle() {
  let dragging = false;
  let startX   = 0;
  let startW   = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX   = e.clientX;
    startW   = listPane.offsetWidth;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newW = Math.max(250, Math.min(window.innerWidth - 250, startW + e.clientX - startX));
    listPane.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveColWidths();
  });
}

// ── Column resize (drag on header) ───────────────────────────────────────

function initColResize() {
  document.querySelectorAll('.col-rh').forEach(handle => {
    const cell  = handle.parentElement;
    const colId = cell.dataset.col;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = cell.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor    = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const newW = Math.max(28, startW + e.clientX - startX);
        document.documentElement.style.setProperty(`--col-${colId}`, newW + 'px');
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.body.style.cursor    = '';
        document.body.style.userSelect = '';
        saveColWidths();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}

// ── Column visibility ─────────────────────────────────────────────────────

function applyColVisibility() {
  for (const [col, vis] of Object.entries(colVisible))
    listPane.classList.toggle(`hide-${col}`, !vis);
  saveColVisibility();
}

function initColSettings() {
  const cfgBtn = document.getElementById('col-cfg-btn');
  const menu   = document.createElement('div');
  menu.id = 'col-cfg-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);

  function renderMenu() {
    menu.innerHTML = '';
    for (const [col, label] of Object.entries(COL_LABELS)) {
      const row = document.createElement('label');
      row.className = 'col-cfg-row';
      const chk = document.createElement('input');
      chk.type    = 'checkbox';
      chk.checked = colVisible[col];
      chk.addEventListener('change', () => {
        colVisible[col] = chk.checked;
        applyColVisibility();
      });
      row.appendChild(chk);
      row.appendChild(document.createTextNode(label));
      menu.appendChild(row);
    }
    // Separator + Reset widths button
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #3c3c3c;margin:4px 0;';
    menu.appendChild(sep);
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺ Скинути ширини';
    resetBtn.style.cssText = 'width:100%;background:none;border:none;color:#aaa;cursor:pointer;padding:5px 8px;text-align:left;font-size:11px;';
    resetBtn.addEventListener('mouseenter', () => resetBtn.style.color = '#fff');
    resetBtn.addEventListener('mouseleave', () => resetBtn.style.color = '#aaa');
    resetBtn.addEventListener('click', e => {
      e.stopPropagation();
      resetColWidths();
      menu.style.display = 'none';
    });
    menu.appendChild(resetBtn);
  }

  cfgBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.style.display === 'none') {
      renderMenu();
      const r = cfgBtn.getBoundingClientRect();
      menu.style.right   = (window.innerWidth - r.right) + 'px';
      menu.style.top     = r.bottom + 4 + 'px';
      menu.style.left    = 'auto';
      menu.style.display = 'block';
    } else {
      menu.style.display = 'none';
    }
  });

  document.addEventListener('click', () => { menu.style.display = 'none'; });
}

// ── Unified settings persistence ─────────────────────────────────────────

let _saveTimer = null;

function saveAllSettings() {
  // Debounce — щоб не писати файл при кожному px ресайзу
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_doSave, 400);
}

function _doSave() {
  const widths = {};
  for (const id of COL_IDS) {
    const v = document.documentElement.style.getPropertyValue(`--col-${id}`);
    if (v) widths[id] = v;
  }
  const lw = listPane.style.width;
  if (lw) widths['_listPane'] = lw;

  const data = {
    colWidths:       widths,
    colVis:          { ...colVisible },
    excludeTerms:    [...excludeTerms],
    recent:          getRecent(),
    detailCollapsed: detailCollapsed,
    fontSize:        fontSize,
    colsLocked:      colsLocked,
    welcomeSeen:     true,
    pharmacyId:      pharmacyId,
  };

  if (window.electronAPI?.saveSettings) {
    window.electronAPI.saveSettings(data);
  }
  // Також у localStorage як резерв
  localStorage.setItem('loki-col-widths',       JSON.stringify(widths));
  localStorage.setItem('loki-col-vis',          JSON.stringify(colVisible));
  localStorage.setItem('loki-exclude',          JSON.stringify(excludeTerms));
  localStorage.setItem('loki-detail-collapsed', detailCollapsed ? '1' : '0');
  localStorage.setItem('loki-cols-locked',      colsLocked      ? '1' : '0');
  localStorage.setItem('loki-welcome-seen',     '1');
}

async function loadAllSettings() {
  let data = null;
  if (window.electronAPI?.loadSettings) {
    data = await window.electronAPI.loadSettings();
  }

  if (data) {
    // З файлу
    if (data.colWidths) {
      for (const [id, val] of Object.entries(data.colWidths)) {
        if (id === '_listPane') { listPane.style.width = val; continue; }
        document.documentElement.style.setProperty(`--col-${id}`, val);
      }
    }
    if (data.colVis) {
      for (const k of Object.keys(colVisible)) {
        if (k in data.colVis) colVisible[k] = data.colVis[k];
      }
      applyColVisibility();
    }
    if (data.excludeTerms) {
      excludeTerms = data.excludeTerms;
      updateExcludeBtn();
    }
    if (data.recent) {
      localStorage.setItem(RECENT_KEY, JSON.stringify(data.recent));
    }
    if (data.detailCollapsed) applyDetailCollapsed(true);
    if (data.fontSize) setFontSize(data.fontSize);
    if (data.colsLocked) applyColLock(true);
    if (data.pharmacyId) pharmacyId = data.pharmacyId;
    return !!data.welcomeSeen;
  } else {
    // Fallback — localStorage
    loadColVisibility();
    loadColWidths();
    loadExcludeTerms();
    updateExcludeBtn();
    const sc = localStorage.getItem('loki-detail-collapsed');
    if (sc === '1') applyDetailCollapsed(true);
    const lc = localStorage.getItem('loki-cols-locked');
    if (lc === '1') applyColLock(true);
    return localStorage.getItem('loki-welcome-seen') === '1';
  }
}

// ── Column width / visibility persistence ─────────────────────────────────

const COL_IDS = ['time', 'trace', 'comp', 'dir', 'level'];

function saveColWidths() { saveAllSettings(); }

const COL_DEFAULTS = { time: '152px', level: '52px', trace: '80px', comp: '56px', dir: '30px' };

function resetColWidths() {
  for (const [id, val] of Object.entries(COL_DEFAULTS)) {
    document.documentElement.style.setProperty(`--col-${id}`, val);
  }
  saveAllSettings();
}

function loadColWidths() {
  try {
    const saved = localStorage.getItem('loki-col-widths');
    if (!saved) return;
    const widths = JSON.parse(saved);
    for (const [id, val] of Object.entries(widths)) {
      if (id === '_listPane') { listPane.style.width = val; continue; }
      document.documentElement.style.setProperty(`--col-${id}`, val);
    }
  } catch {}
}

function saveColVisibility() { saveAllSettings(); }

function loadColVisibility() {
  try {
    const saved = localStorage.getItem('loki-col-vis');
    if (!saved) return;
    const vis = JSON.parse(saved);
    for (const k of Object.keys(colVisible)) {
      if (k in vis) colVisible[k] = vis[k];
    }
    applyColVisibility();
  } catch {}
}

// ── Dynamic column widths ─────────────────────────────────────────────────

function computeColWidths() {
  if (!allLines.length) return;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '12.5px Consolas, "Courier New", monospace';

  let maxTime = 0, maxTrace = 0, maxComp = 0, maxDir = 0;
  // Sample up to 2000 lines for performance
  const sample = allLines.length > 2000
    ? [...allLines.slice(0, 1000), ...allLines.slice(-1000)]
    : allLines;

  for (const l of sample) {
    if (l.time)  maxTime  = Math.max(maxTime,  ctx.measureText(l.time).width);
    if (l.trace) maxTrace = Math.max(maxTrace, ctx.measureText(l.trace).width);
    if (l.comp)  maxComp  = Math.max(maxComp,  ctx.measureText(l.comp).width);
    if (l.dir)   maxDir   = Math.max(maxDir,   ctx.measureText(l.dir).width);
  }

  const s = document.documentElement.style;
  const px = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.ceil(v))) + 'px';
  s.setProperty('--col-time',  px(maxTime  + 12, 100, 220));
  s.setProperty('--col-trace', px(maxTrace + 14,  55, 130));
  s.setProperty('--col-comp',  px(maxComp  + 10,  45,  90));
  s.setProperty('--col-dir',   px(maxDir   + 10,  24,  50));
}

// ── Saved entries ─────────────────────────────────────────────────────────

function isLineSaved(line) {
  return savedLines.some(l => l.idx === line.idx);
}

function toggleSaveLine(line) {
  if (!line) return;
  const i = savedLines.findIndex(l => l.idx === line.idx);
  if (i !== -1) {
    savedLines.splice(i, 1);
    if (savedActiveIdx >= savedLines.length) savedActiveIdx = Math.max(0, savedLines.length - 1);
    if (showingSaved) {
      if (savedLines.length === 0) showDetailView();
      else renderSavedPane();
    }
  } else {
    savedLines.push(line);
    savedActiveIdx = savedLines.length - 1; // одразу активуємо нову вкладку
    showSavedView();
  }
  updateSaveBtn(line);
  updateSavedCount();
}

function updateSaveBtn(line) {
  if (!line) { saveBtn.classList.remove('saved'); saveBtn.textContent = '☆'; return; }
  const saved = isLineSaved(line);
  saveBtn.classList.toggle('saved', saved);
  saveBtn.textContent = saved ? '★' : '☆';
}

function updateSavedCount() {
  savedCountEl.textContent = savedLines.length;
  savedTabBtn.classList.toggle('has-items', savedLines.length > 0);
}

function showDetailView() {
  showingSaved = false;
  detailView.style.display = 'flex';
  savedPane.classList.remove('visible');
  savedTabBtn.classList.remove('active-tab');
}

function showSavedView() {
  showingSaved = true;
  detailView.style.display = 'none';
  savedPane.classList.add('visible');
  savedTabBtn.classList.add('active-tab');
  renderSavedPane();
}

function renderSavedPane() {
  savedPane.innerHTML = '';

  if (!savedLines.length) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:20px;color:#555;font-size:13px;text-align:center';
    msg.textContent = 'Немає збережених записів. Натисніть ☆ щоб зберегти.';
    savedPane.appendChild(msg);
    return;
  }

  // ── Таб-бар ──
  const tabBar = document.createElement('div');
  tabBar.className = 'saved-tab-bar';

  savedLines.forEach((line, i) => {
    const tab = document.createElement('div');
    tab.className = 'saved-tab' + (i === savedActiveIdx ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'saved-tab-label';
    // Скорочений час (тільки час, без дати) + comp + dir
    const timePart = line.time ? line.time.split(' ')[1] : '';
    label.textContent = [timePart, line.comp, line.dir].filter(Boolean).join(' ');
    label.title = [line.time, line.trace, line.comp, line.dir].filter(Boolean).join('  ');

    const close = document.createElement('button');
    close.className = 'saved-tab-close';
    close.textContent = '×';
    close.title = 'Видалити';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      savedLines.splice(i, 1);
      if (savedActiveIdx >= savedLines.length) savedActiveIdx = Math.max(0, savedLines.length - 1);
      updateSavedCount();
      updateSaveBtn(currentLine());
      if (savedLines.length === 0) showDetailView();
      else renderSavedPane();
    });

    tab.appendChild(label);
    tab.appendChild(close);
    tab.addEventListener('click', () => {
      savedActiveIdx = i;
      renderSavedPane();
    });
    tabBar.appendChild(tab);
  });

  // "Порівняти" кнопка — тільки якщо 2+ збережених і є Electron API
  if (savedLines.length >= 2 && window.electronAPI?.openDiff) {
    const diffBtn = document.createElement('button');
    diffBtn.className = 'tb-btn secondary saved-diff-btn';
    diffBtn.textContent = '⟺ Порівняти';
    diffBtn.addEventListener('click', openDiffWindow);
    tabBar.appendChild(diffBtn);
  }

  savedPane.appendChild(tabBar);

  // ── Вміст активної вкладки ──
  const content = document.createElement('div');
  content.className = 'saved-tab-content';

  const activeLine = savedLines[savedActiveIdx];
  if (activeLine) {
    // Meta
    const meta = document.createElement('div');
    meta.className = 'saved-tab-meta';
    const b = document.createElement('b');
    b.textContent = activeLine.time + '  ';
    meta.appendChild(b);
    meta.appendChild(document.createTextNode(
      [activeLine.trace, activeLine.comp, activeLine.dir].filter(Boolean).join('  ')
    ));
    content.appendChild(meta);

    // JSON
    const body = document.createElement('div');
    body.className = 'saved-tab-body';
    body.appendChild(renderJsonFromRaw(activeLine.raw, { sorted: true }));
    const bq = bodySearch.value.trim();
    if (bq) highlightSearch(body, bq);
    content.appendChild(body);
  }

  savedPane.appendChild(content);
}

// ── Diff window ───────────────────────────────────────────────────────────

function openDiffWindow() {
  if (!window.electronAPI?.openDiff) return;
  window.electronAPI.openDiff(savedLines.map(l => ({
    time: l.time, level: l.level, trace: l.trace,
    comp: l.comp, dir: l.dir, body: l.body, raw: l.raw, idx: l.idx,
  })));
}

// ── Exclude filter ────────────────────────────────────────────────────────

function saveExcludeTerms() { saveAllSettings(); }

function loadExcludeTerms() {
  try {
    const saved = localStorage.getItem('loki-exclude');
    if (saved) excludeTerms = JSON.parse(saved);
  } catch {}
}

function updateExcludeBtn() {
  const excludeBtn = document.getElementById('exclude-btn');
  if (!excludeBtn) return;
  if (excludeTerms.length > 0) {
    excludeBtn.classList.add('has-excludes');
    excludeBtn.textContent = `⊘ Виключити (${excludeTerms.length})`;
  } else {
    excludeBtn.classList.remove('has-excludes');
    excludeBtn.textContent = '⊘ Виключити';
  }
}

function initExcludePanel() {
  const excludeBtn = document.getElementById('exclude-btn');
  const panel = document.createElement('div');
  panel.id = 'exclude-panel';
  panel.style.display = 'none';
  document.body.appendChild(panel);

  function renderPanel() {
    panel.innerHTML = '';

    const title = document.createElement('div');
    title.id = 'exclude-panel-title';
    title.textContent = 'Виключити рядки що містять:';
    panel.appendChild(title);

    const row = document.createElement('div');
    row.id = 'exclude-input-row';

    const input = document.createElement('input');
    input.id = 'exclude-input';
    input.placeholder = 'Наприклад: online, health';
    input.autocomplete = 'off';
    row.appendChild(input);

    const addBtn = document.createElement('button');
    addBtn.id = 'exclude-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Додати';
    row.appendChild(addBtn);
    panel.appendChild(row);

    const chips = document.createElement('div');
    chips.id = 'exclude-chips';
    panel.appendChild(chips);

    function renderChips() {
      chips.innerHTML = '';
      if (!excludeTerms.length) {
        const hint = document.createElement('span');
        hint.style.cssText = 'font-size:11px;color:#555;';
        hint.textContent = 'Немає активних виключень';
        chips.appendChild(hint);
        return;
      }
      for (let i = 0; i < excludeTerms.length; i++) {
        const chip = document.createElement('div');
        chip.className = 'exclude-chip';

        const txt = document.createElement('span');
        txt.className = 'exclude-chip-text';
        txt.textContent = excludeTerms[i];
        txt.title = excludeTerms[i];

        const rm = document.createElement('button');
        rm.className = 'exclude-chip-remove';
        rm.textContent = '×';
        rm.title = 'Видалити';
        rm.addEventListener('click', () => {
          excludeTerms.splice(i, 1);
          saveExcludeTerms();
          updateExcludeBtn();
          recomputeFiltered(); clearRendered(); scheduleRender();
          renderChips();
          if (clearAllBtn) clearAllBtn.style.display = excludeTerms.length ? 'block' : 'none';
        });

        chip.appendChild(txt);
        chip.appendChild(rm);
        chips.appendChild(chip);
      }
    }
    renderChips();

    function addTerm() {
      const val = input.value.trim();
      if (!val) return;
      // Support comma-separated input
      const parts = val.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!excludeTerms.includes(p)) excludeTerms.push(p);
      }
      input.value = '';
      saveExcludeTerms();
      updateExcludeBtn();
      recomputeFiltered(); clearRendered(); scheduleRender();
      renderChips();
      if (clearAllBtn) clearAllBtn.style.display = excludeTerms.length ? 'block' : 'none';
      input.focus();
    }

    addBtn.addEventListener('click', addTerm);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTerm(); } });

    const clearAllBtn = document.createElement('button');
    clearAllBtn.id = 'exclude-clear-btn';
    clearAllBtn.textContent = '✕ Скинути всі виключення';
    clearAllBtn.style.display = excludeTerms.length ? 'block' : 'none';
    clearAllBtn.addEventListener('click', () => {
      excludeTerms = [];
      saveExcludeTerms();
      updateExcludeBtn();
      recomputeFiltered(); clearRendered(); scheduleRender();
      renderChips();
      clearAllBtn.style.display = 'none';
    });
    panel.appendChild(clearAllBtn);

    // Focus input when panel opens
    setTimeout(() => input.focus(), 30);
  }

  excludeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.style.display === 'none') {
      renderPanel();
      const r = excludeBtn.getBoundingClientRect();
      panel.style.right = (window.innerWidth - r.right) + 'px';
      panel.style.top   = r.bottom + 6 + 'px';
      panel.style.left  = 'auto';
      panel.style.display = 'block';
    } else {
      panel.style.display = 'none';
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== excludeBtn) {
      panel.style.display = 'none';
    }
  });
}

// ── Detail pane collapse ──────────────────────────────────────────────────

function applyDetailCollapsed(collapsed) {
  detailCollapsed = collapsed;
  detailPane.classList.toggle('collapsed', collapsed);
  resizeHandle.classList.toggle('detail-hidden', collapsed);
  listPane.classList.toggle('expand-full', collapsed);
  if (detailToggleBtn) detailToggleBtn.textContent = collapsed ? '◀' : '▶';
  saveAllSettings();
}

function toggleDetailPane() {
  applyDetailCollapsed(!detailCollapsed);
}

// ── Selection bar ─────────────────────────────────────────────────────────

function updateSelectionBar() {
  const n = selectedLineIds.size;
  if (n === 0) {
    selectionBar.classList.remove('show');
    // Reset show-only mode if no selection
    if (showOnlySelected) {
      showOnlySelected = false;
      showSelectedBtn.classList.remove('active');
      recomputeFiltered();
      clearRendered();
      scheduleRender();
    }
    return;
  }
  selectionCountEl.textContent = `${n} вибрано`;
  selectionBar.classList.add('show');
}

function clearSelection() {
  selectedLineIds.clear();
  showOnlySelected = false;
  showSelectedBtn.classList.remove('active');
  updateSelectionBar();
  recomputeFiltered();
  clearRendered();
  scheduleRender();
}

async function exportSelectedLines() {
  const lines = filteredLines.filter(l => selectedLineIds.has(l.idx));
  if (!lines.length) return;
  const text = lines.map(l => l.raw).join('\n');
  if (window.electronAPI?.saveFile) {
    await window.electronAPI.saveFile(text);
  } else {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'selected_logs.txt'; a.click();
    URL.revokeObjectURL(url);
  }
}

// ── Copy body / raw ───────────────────────────────────────────────────────

function copyJsonToClipboard() {
  const line = showingSaved ? savedLines[savedActiveIdx] : currentLine();
  if (!line) return;
  // Copy the body/message portion (JSON content)
  const text = line.body || line.raw;
  navigator.clipboard.writeText(text).then(() => {
    const prev = copyJsonBtn.textContent;
    copyJsonBtn.textContent = '✓';
    setTimeout(() => { copyJsonBtn.textContent = prev; }, 1200);
  });
}

function copyRawToClipboard() {
  const line = showingSaved ? savedLines[savedActiveIdx] : currentLine();
  if (!line) return;
  navigator.clipboard.writeText(line.raw).then(() => {
    const prev = copyRawBtn.textContent;
    copyRawBtn.textContent = '✓';
    setTimeout(() => { copyRawBtn.textContent = prev; }, 1200);
  });
}

// ── Drag & Drop ───────────────────────────────────────────────────────────

function initDragDrop() {
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  document.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    const ext = (file.name.split('.').pop() || '').toLowerCase();

    if (window.electronAPI) {
      // Electron: use main-process handlers (gz/zip handled transparently)
      await openByPath(file.path || file.name);
    } else {
      // Browser fallback
      if (ext === 'gz') {
        const buf = await file.arrayBuffer();
        const text = await decompressGzBrowser(buf);
        loadText(text, file.name);
      } else if (ext !== 'zip') {
        const text = await file.text();
        loadText(text, file.name);
      }
      // zip not supported without Electron API
    }
  });
}

// ── Body search ───────────────────────────────────────────────────────────

let bodySearchTimer = null;
function applyBodySearch() {
  if (bodySearchTimer) clearTimeout(bodySearchTimer);
  bodySearchTimer = setTimeout(() => {
    bodySearchQuery = bodySearch.value.trim();
    if (showingSaved) {
      // Re-render saved pane — it will pick up bodySearch.value and apply highlight
      renderSavedPane();
      return;
    }
    // Re-render clean JSON, then highlight — гарантує чистий стан
    const line = currentLine();
    if (!line) return;
    detailContent.innerHTML = '';
    detailContent.appendChild(renderJsonFromRaw(line.raw, { sorted: true }));
    if (bodySearchQuery) highlightSearch(detailContent, bodySearchQuery);
  }, 100);
}

// ── Bookmarks ─────────────────────────────────────────────────────────────

function toggleBookmark() {
  const line = currentLine();
  if (!line) return;
  if (bookmarkedLineIds.has(line.idx)) bookmarkedLineIds.delete(line.idx);
  else bookmarkedLineIds.add(line.idx);
  refreshSelectedClass();
}

function navigateBookmark(dir) {
  const bmarks = [];
  for (let i = 0; i < filteredLines.length; i++) {
    if (bookmarkedLineIds.has(filteredLines[i].idx)) bmarks.push(i);
  }
  if (!bmarks.length) return;
  let target;
  if (dir > 0) {
    target = bmarks.find(i => i > selectedIdx) ?? bmarks[0];
  } else {
    const rev = [...bmarks].reverse();
    target = rev.find(i => i < selectedIdx) ?? bmarks[bmarks.length - 1];
  }
  selectedIdx = target;
  refreshSelectedClass();
  showDetail(filteredLines[target]);
  logContainer.scrollTop = Math.max(0, rowTops[target] - logContainer.clientHeight / 2);
}

// ── Font size ─────────────────────────────────────────────────────────────

function computeROW_H() {
  const base = wrapMode ? 66 : 22;
  return Math.max(16, Math.round(base * fontSize / 12.5));
}

function applyWrapRowH() {
  // Sync --wrap-row-h CSS variable so CSS matches JS ROW_H in wrap mode
  document.documentElement.style.setProperty('--wrap-row-h', ROW_H + 'px');
}

function setFontSize(size) {
  fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
  document.documentElement.style.setProperty('--row-font',    fontSize + 'px');
  document.documentElement.style.setProperty('--detail-font', Math.max(9, fontSize - 0.5) + 'px');
  ROW_H = computeROW_H();
  applyWrapRowH();
  const el = document.getElementById('font-size-val');
  if (el) el.textContent = Math.round(fontSize);
  recomputeRowTops();
  clearRendered();
  scheduleRender();
  saveAllSettings();
}

// ── Wrap toggle ───────────────────────────────────────────────────────────

// ── Welcome / Help modal ──────────────────────────────────────────────────

function showWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  if (overlay) overlay.classList.add('visible');
}

function hideWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  if (overlay) overlay.classList.remove('visible');
  saveAllSettings(); // mark welcomeSeen = true
}

function initWelcome(alreadySeen) {
  const closeBtn = document.getElementById('welcome-close');
  const overlay  = document.getElementById('welcome-overlay');
  if (!overlay || !closeBtn) return;

  closeBtn.addEventListener('click', hideWelcome);
  // Клік на backdrop (поза модалкою) теж закриває
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideWelcome();
  });

  if (!alreadySeen) showWelcome();
}

function applyColLock(locked) {
  colsLocked = locked;
  listPane.classList.toggle('cols-locked', colsLocked);
  const btn = document.getElementById('col-lock-btn');
  if (btn) {
    btn.classList.toggle('locked', colsLocked);
    btn.title = colsLocked ? 'Розблокувати ширину колонок' : 'Заблокувати ширину колонок';
    btn.textContent = colsLocked ? '🔒' : '🔓'; // 🔒 / 🔓
  }
}

function toggleColLock() {
  applyColLock(!colsLocked);
  saveAllSettings();
}

function toggleWrap() {
  wrapMode = !wrapMode;
  ROW_H = computeROW_H();
  applyWrapRowH();
  listPane.classList.toggle('wrap-mode', wrapMode);
  if (wrapBtn) wrapBtn.classList.toggle('active', wrapMode);
  recomputeRowTops();
  clearRendered();
  scheduleRender();
}

// ── Recent files ──────────────────────────────────────────────────────────

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function addToRecent(filePath) {
  if (!filePath) return;
  let r = getRecent();
  r = [filePath, ...r.filter(p => p !== filePath)].slice(0, 10);
  localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  saveAllSettings();
}

function showRecentMenu() {
  document.getElementById('recent-menu')?.remove();
  const recent = getRecent();
  if (!recent.length) return;
  const menu = document.createElement('div');
  menu.id = 'recent-menu';
  for (const fp of recent) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const name = document.createElement('b');
    name.textContent = fp.split(/[\\/]/).pop();
    const pth = document.createElement('span');
    pth.className = 'recent-item-path';
    pth.textContent = fp;
    item.appendChild(name);
    item.appendChild(pth);
    item.title = fp;
    item.addEventListener('click', async () => { menu.remove(); await openByPath(fp); });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = recentBtn.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.top  = r.bottom + 4 + 'px';
  setTimeout(() => {
    document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); });
  }, 0);
}

// ── File tabs ─────────────────────────────────────────────────────────────

function makeTab(id, label) {
  return { id, label: label || 'Новий', filePath: null, allLines: [], selectedIdx: -1, scrollTop: 0, liveMode: false, bookmarks: new Set() };
}

function saveActiveTab() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  tab.allLines    = allLines;
  tab.filePath    = currentFilePath;
  tab.selectedIdx = selectedIdx;
  tab.scrollTop   = logContainer.scrollTop;
  tab.liveMode    = liveMode;
  tab.bookmarks   = bookmarkedLineIds;
}

function applyTabState(tab) {
  if (liveMode && window.electronAPI) window.electronAPI.unwatchFile();
  liveMode = false;
  liveBtn.classList.remove('live-on');
  liveBtn.textContent = '⟳ Live';
  allLines          = tab.allLines;
  currentFilePath   = tab.filePath;
  selectedIdx       = tab.selectedIdx;
  bookmarkedLineIds = tab.bookmarks;
  recomputeFiltered();
  clearRendered();
  scheduleRender();
  requestAnimationFrame(() => { logContainer.scrollTop = tab.scrollTop; });
  if (tab.liveMode) setLiveMode(true);
  if (allLines.length) showWorkspace();
  else { dropZone.classList.add('visible'); workspace.style.display = 'none'; }
}

function switchTab(tabId) {
  if (tabId === activeTabId) return;
  saveActiveTab();
  activeTabId = tabId;
  applyTabState(tabs.find(t => t.id === tabId));
  updateTabBar();
}

function openNewTabAndFile() {
  saveActiveTab();
  _tabCtr++;
  const tab = makeTab(_tabCtr);
  tabs.push(tab);
  activeTabId       = tab.id;
  allLines          = [];
  currentFilePath   = null;
  selectedIdx       = -1;
  bookmarkedLineIds = new Set();
  liveMode          = false;
  liveBtn.classList.remove('live-on');
  liveBtn.textContent = '⟳ Live';
  updateTabBar();
  openFileDialog();
}

function closeTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  if (tabId === activeTabId && liveMode && window.electronAPI) window.electronAPI.unwatchFile();
  if (tabs.length === 1) {
    // Скидаємо єдину вкладку
    Object.assign(tabs[0], makeTab(tabs[0].id));
    applyTabState(tabs[0]);
    updateTabBar();
    return;
  }
  tabs.splice(idx, 1);
  if (tabId === activeTabId) {
    activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
    applyTabState(tabs.find(t => t.id === activeTabId));
  }
  updateTabBar();
}

function updateTabBar() {
  const tabBar = document.getElementById('file-tabs');
  if (!tabBar) return;
  tabBar.innerHTML = '';
  for (const tab of tabs) {
    const el  = document.createElement('div');
    el.className = 'file-tab' + (tab.id === activeTabId ? ' active' : '');
    const lbl = document.createElement('span');
    lbl.className   = 'file-tab-label';
    lbl.textContent = tab.label;
    lbl.title       = tab.filePath || '';
    el.appendChild(lbl);
    const cls = document.createElement('button');
    cls.className   = 'file-tab-close';
    cls.textContent = '×';
    cls.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(cls);
    el.addEventListener('click', () => switchTab(tab.id));
    tabBar.appendChild(el);
  }
  const addBtn = document.createElement('button');
  addBtn.className   = 'file-tab-add';
  addBtn.textContent = '+';
  addBtn.title       = 'Відкрити в новій вкладці';
  addBtn.addEventListener('click', openNewTabAndFile);
  tabBar.appendChild(addBtn);
}

// ── Time delta ────────────────────────────────────────────────────────────

function parseTimeMs(timeStr) {
  if (!timeStr) return null;
  // "2026/05/27 14:44:23" → "2026-05-27T14:44:23" (ISO 8601)
  const d = new Date(timeStr.replace(/\//g, '-').replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d.getTime();
}

function formatDelta(ms) {
  if (ms < 1000) return `${ms}мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}с`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}хв ${Math.floor((ms % 60000) / 1000)}с`;
  return `${Math.floor(ms / 3600000)}г ${Math.floor((ms % 3600000) / 60000)}хв`;
}

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  workspace.style.display = 'none';
  dropZone.classList.add('visible');

  // Restore persisted settings (file → localStorage fallback)
  const welcomeSeen = await loadAllSettings();

  // Welcome modal (first run)
  initWelcome(welcomeSeen);

  // Init file tabs
  _tabCtr = 1;
  tabs = [makeTab(1)];
  activeTabId = 1;
  updateTabBar();

  initResizeHandle();
  initColResize();
  initColSettings();
  initDragDrop();

  if (detailToggleBtn) detailToggleBtn.addEventListener('click', toggleDetailPane);

  initExcludePanel();

  logContainer.addEventListener('scroll', scheduleRender, { passive: true });

  openBtn.addEventListener('click', openFileDialog);

  if (window.electronAPI) {
    window.electronAPI.onMenuOpen(() => openFileDialog());
    window.electronAPI.onOpenFilePath?.((filePath) => openByPath(filePath));
    window.electronAPI.onShowHelp?.(() => showWelcome());
  }

  liveBtn.addEventListener('click', () => setLiveMode(!liveMode));

  searchInput.addEventListener('input', () => {
    const prevLine = currentLine(); // запам'ятовуємо рядок до перефільтрації
    searchQuery = searchInput.value.trim();
    searchRe    = buildSearchRe(searchQuery);
    searchNavIdx = 0;
    recomputeFiltered();
    clearRendered();

    // Відновлюємо позицію: знаходимо де опинився попередній рядок
    if (prevLine) {
      const newIdx = filteredLines.findIndex(l => l.idx === prevLine.idx);
      if (newIdx !== -1) {
        selectedIdx = newIdx;
        const rowTop = rowTops[newIdx];
        logContainer.scrollTop = Math.max(0, rowTop - logContainer.clientHeight / 2);
      } else {
        selectedIdx = -1;
      }
    }

    scheduleRender();
  });

  document.querySelectorAll('.toggle-btn[data-level]').forEach(btn => {
    btn.addEventListener('click', () => handleLevelToggle(btn));
  });

  document.querySelectorAll('.toggle-btn[data-comp]').forEach(btn => {
    btn.addEventListener('click', () => handleCompToggle(btn));
  });

  traceClear.addEventListener('click', clearTraceHighlight);

  copyJsonBtn.addEventListener('click', copyJsonToClipboard);
  copyRawBtn.addEventListener('click', copyRawToClipboard);

  if (recentBtn) recentBtn.addEventListener('click', (e) => { e.stopPropagation(); showRecentMenu(); });
  if (wrapBtn)   wrapBtn.addEventListener('click', toggleWrap);

  const colLockBtn = document.getElementById('col-lock-btn');
  if (colLockBtn) colLockBtn.addEventListener('click', toggleColLock);

  const fontDecBtn = document.getElementById('font-dec');
  const fontIncBtn = document.getElementById('font-inc');
  if (fontDecBtn) fontDecBtn.addEventListener('click', () => setFontSize(fontSize - 1));
  if (fontIncBtn) fontIncBtn.addEventListener('click', () => setFontSize(fontSize + 1));

  showSelectedBtn.addEventListener('click', () => {
    if (!selectedLineIds.size) return;
    showOnlySelected = !showOnlySelected;
    showSelectedBtn.classList.toggle('active', showOnlySelected);
    recomputeFiltered();
    clearRendered();
    scheduleRender();
  });

  exportSelectedBtn.addEventListener('click', exportSelectedLines);
  clearSelectionBtn.addEventListener('click', clearSelection);

  expandAllBtn.addEventListener('click', () => {
    if (showingSaved) {
      const body = savedPane.querySelector('.saved-tab-body');
      if (body) setAllCollapsed(body, false);
    } else {
      setAllCollapsed(detailContent, false);
    }
  });
  collapseAllBtn.addEventListener('click', () => {
    if (showingSaved) {
      const body = savedPane.querySelector('.saved-tab-body');
      if (body) setAllCollapsed(body, true);
    } else {
      setAllCollapsed(detailContent, true);
    }
  });

  saveBtn.addEventListener('click', () => toggleSaveLine(currentLine()));

  savedTabBtn.addEventListener('click', () => {
    if (showingSaved) showDetailView();
    else showSavedView();
  });

  bodySearch.addEventListener('input', applyBodySearch);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!filteredLines.length) return;
      e.preventDefault();
      let next = selectedIdx + (e.key === 'ArrowDown' ? 1 : -1);
      next = Math.max(0, Math.min(filteredLines.length - 1, next));
      selectedIdx = next;
      refreshSelectedClass();
      showDetail(filteredLines[next]);
      const rowTop = rowTops[next];
      if (rowTop < logContainer.scrollTop)
        logContainer.scrollTop = rowTop;
      if (rowTop + ROW_H > logContainer.scrollTop + logContainer.clientHeight)
        logContainer.scrollTop = rowTop + ROW_H - logContainer.clientHeight;
    } else if (e.key === 'Escape') {
      if (highlightedTrace) clearTraceHighlight();
      else if (selectedLineIds.size) clearSelection();
    } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      copyJsonToClipboard();
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (searchQuery) {
        if (e.shiftKey) navigateSearch(-1);
        else navigateSearch(1);
      }
    } else if (e.key === 'F2') {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        if (e.shiftKey) navigateBookmark(-1);
        else navigateBookmark(1);
      }
    } else if (e.code === 'KeyB' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') toggleBookmark();
    } else if (e.code === 'KeyW' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') toggleWrap();
    }
  });
}

// ── Push log by pharmacy ID ───────────────────────────────────────────────

const WEB_BASE   = 'https://ihordvorkovyip.github.io/Loki/';
const SHARE_REPO = 'IhorDvorkovyiP/Loki';
const RAW_BASE   = `https://raw.githubusercontent.com/${SHARE_REPO}/shared-logs/logs/`;
const PUSH_LIMIT = 10 * 1024 * 1024; // 10 MB

// Saved pharmacy ID (persisted in settings)
let pharmacyId = '';

function showPushDialog() {
  document.getElementById('push-dialog')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'push-dialog';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#252526;border:1px solid #3c3c3c;border-radius:8px;padding:24px 28px;min-width:340px;display:flex;flex-direction:column;gap:14px;';

  // Title
  const title = document.createElement('div');
  title.style.cssText = 'font-size:14px;font-weight:bold;color:#ccc;';
  title.textContent = '📤 Відправити лог';
  box.appendChild(title);

  // Pharmacy ID input
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:#666;';
  hint.textContent = 'ID аптеки (лише латиниця/цифри, напр: CL2, CL212)';
  box.appendChild(hint);

  const input = document.createElement('input');
  input.value = pharmacyId;
  input.placeholder = 'ID аптеки...';
  input.autocomplete = 'off';
  input.style.cssText = 'background:#1e1e1e;border:1px solid #555;color:#ccc;padding:7px 10px;border-radius:4px;font-family:inherit;font-size:13px;outline:none;';
  input.addEventListener('keydown', e => { if (e.key === 'Enter') labelInput.focus(); });
  box.appendChild(input);

  // Label / description input
  const labelHint = document.createElement('div');
  labelHint.style.cssText = 'font-size:11px;color:#666;';
  labelHint.textContent = 'Опис (довільний текст, буде видно в списку аптек)';
  box.appendChild(labelHint);

  const labelInput = document.createElement('input');
  labelInput.value = '';
  labelInput.placeholder = 'напр: Аптека 731 — проблема з чеком';
  labelInput.autocomplete = 'off';
  labelInput.style.cssText = 'background:#1e1e1e;border:1px solid #555;color:#ccc;padding:7px 10px;border-radius:4px;font-family:inherit;font-size:13px;outline:none;';
  labelInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
  box.appendChild(labelInput);

  // Lines info
  const lines = filteredLines.length && filteredLines.length < allLines.length
    ? filteredLines : allLines;
  const info = document.createElement('div');
  info.style.cssText = 'font-size:11px;color:#555;';
  info.textContent = `Буде відправлено: ${lines.length} рядків${filteredLines.length < allLines.length ? ' (поточний фільтр)' : ''}`;
  box.appendChild(info);

  // Buttons row
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Скасувати';
  cancelBtn.style.cssText = 'background:transparent;border:1px solid #555;color:#888;padding:6px 16px;border-radius:3px;cursor:pointer;font-family:inherit;';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const sendBtn = document.createElement('button');
  sendBtn.textContent = '📤 Відправити';
  sendBtn.style.cssText = 'background:#0e639c;border:none;color:#fff;padding:6px 18px;border-radius:3px;cursor:pointer;font-family:inherit;font-weight:bold;';

  row.appendChild(cancelBtn);
  row.appendChild(sendBtn);
  box.appendChild(row);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'font-size:12px;min-height:18px;';
  box.appendChild(statusEl);

  async function doSend() {
    const id = input.value.trim();
    if (!id) { input.style.borderColor = '#f48771'; return; }
    pharmacyId = id;
    saveAllSettings();

    const content = lines.map(l => l.raw).join('\n');
    if (content.length > PUSH_LIMIT) {
      statusEl.style.color = '#f48771';
      statusEl.textContent = `Занадто великий (${(content.length/1024/1024).toFixed(1)} МБ > 10 МБ). Застосуй фільтр спочатку.`;
      return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Відправлення...';
    statusEl.style.color = '#666';
    statusEl.textContent = 'Підключення до GitHub...';

    const label = labelInput.value.trim() || id;
    try {
      await window.electronAPI.pushLog({ pharmacyId: id, content, label });
      statusEl.style.color = '#6ac26a';
      statusEl.textContent = `✅ Готово! "${label}" доступний на сервері.`;
      sendBtn.textContent = '✅ Відправлено';
      setTimeout(() => overlay.remove(), 2000);
    } catch (e) {
      statusEl.style.color = '#f48771';
      statusEl.textContent = 'Помилка: ' + e.message;
      sendBtn.disabled = false;
      sendBtn.textContent = '📤 Відправити';
    }
  }

  sendBtn.addEventListener('click', doSend);
  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 50);
}

// ── Web mode: pharmacy browser + ?pharmacy=ID loader ─────────────────────

const API_FILES  = `https://api.github.com/repos/${SHARE_REPO}/contents/logs?ref=shared-logs`;
const INDEX_URL  = `https://raw.githubusercontent.com/${SHARE_REPO}/shared-logs/logs/index.json`;

// Fetch { id -> { label, updated } } index; falls back to {} on error
async function fetchIndex() {
  try {
    const r = await fetch(INDEX_URL + '?t=' + Date.now());
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

// Build chip list from file list + optional index labels
function buildChips(container, logFiles, index, onSelect) {
  container.innerHTML = '';
  if (!logFiles.length) {
    container.innerHTML = '<span style="color:#555;font-size:12px;">Поки що немає логів</span>';
    return;
  }
  for (const f of logFiles) {
    const id    = f.name.replace(/\.log$/i, '');
    const meta  = index[id] || {};
    const label = meta.label && meta.label !== id ? meta.label : id;
    const ts    = meta.updated ? `\n${meta.updated}` : '';

    const chip = document.createElement('button');
    chip.title = `ID: ${id}${ts}`;
    chip.style.cssText = 'background:#2d2d2d;border:1px solid #444;color:#9cdcfe;padding:6px 16px;border-radius:20px;cursor:pointer;font-family:inherit;font-size:13px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    chip.appendChild(labelSpan);

    if (meta.updated) {
      const tsSpan = document.createElement('span');
      tsSpan.textContent = ' · ' + meta.updated;
      tsSpan.style.cssText = 'font-size:10px;color:#666;margin-left:4px;';
      chip.appendChild(tsSpan);
    }

    chip.addEventListener('mouseenter', () => { chip.style.background = '#0e639c'; chip.style.color = '#fff'; if (meta.updated) tsSpan && (tsSpan.style.color = '#aaa'); });
    chip.addEventListener('mouseleave', () => { chip.style.background = '#2d2d2d'; chip.style.color = '#9cdcfe'; if (meta.updated) tsSpan && (tsSpan.style.color = '#666'); });
    chip.addEventListener('click',       () => onSelect(id));
    container.appendChild(chip);
  }
}

async function loadFromUrlParams() {
  if (window.electronAPI) return false; // Electron: no URL params

  const params     = new URLSearchParams(window.location.search);
  const pharmacyParam = params.get('pharmacy');

  if (pharmacyParam) {
    // Direct load by pharmacy ID
    await loadPharmacyLog(pharmacyParam);
    return true;
  }

  // No params — show pharmacy browser on drop zone
  showPharmacyBrowser();
  return false;
}

async function loadPharmacyLog(id) {
  dropZone.innerHTML = `<div>⏳ Завантаження логу <b>${id}</b>...</div>`;
  dropZone.classList.add('visible');
  workspace.style.display = 'none';

  try {
    const url = `${RAW_BASE}${encodeURIComponent(id)}.log`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Лог "${id}" не знайдено (HTTP ${res.status})`);
    const content = await res.text();
    loadText(content, `${id}.log`);
    document.title = `Loki — ${id}`;
  } catch (e) {
    dropZone.innerHTML = `<div>❌ ${e.message}</div><div class="hint"><a href="${WEB_BASE}" style="color:#4e9eff">← Назад до списку</a></div>`;
  }
}

function showPharmacyBrowser() {
  dropZone.innerHTML = '';
  dropZone.classList.add('visible');
  workspace.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;width:100%;max-width:480px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:18px;color:#ccc;font-weight:bold;';
  title.textContent = '⚡ Loki — Перегляд логів аптек';
  wrap.appendChild(title);

  // Search input
  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;gap:8px;width:100%;';
  const searchInput = document.createElement('input');
  searchInput.placeholder = 'Введи ID аптеки (CL2, CL212...)';
  searchInput.autocomplete = 'off';
  searchInput.style.cssText = 'flex:1;background:#1e1e1e;border:1px solid #555;color:#ccc;padding:8px 12px;border-radius:4px;font-family:inherit;font-size:13px;outline:none;';
  const goBtn = document.createElement('button');
  goBtn.textContent = 'Відкрити';
  goBtn.style.cssText = 'background:#0e639c;border:none;color:#fff;padding:8px 16px;border-radius:4px;cursor:pointer;font-family:inherit;';
  goBtn.addEventListener('click', () => {
    const id = searchInput.value.trim();
    if (id) { window.history.pushState({}, '', `?pharmacy=${id}`); loadPharmacyLog(id); }
  });
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click(); });
  searchRow.appendChild(searchInput);
  searchRow.appendChild(goBtn);
  wrap.appendChild(searchRow);

  // List of available pharmacies
  const listTitle = document.createElement('div');
  listTitle.style.cssText = 'font-size:11px;color:#555;align-self:flex-start;';
  listTitle.textContent = 'Доступні аптеки:';
  wrap.appendChild(listTitle);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center;';
  list.innerHTML = '<span style="color:#444;font-size:12px;">Завантаження...</span>';
  wrap.appendChild(list);

  // Fetch available pharmacies + labels from GitHub
  Promise.all([fetch(API_FILES).then(r => r.json()), fetchIndex()])
    .then(([files, index]) => {
      const logFiles = Array.isArray(files) ? files.filter(f => f.name.endsWith('.log')) : [];
      buildChips(list, logFiles, index, id => {
        window.history.pushState({}, '', `?pharmacy=${id}`);
        loadPharmacyLog(id);
      });
    })
    .catch(() => {
      list.innerHTML = '<span style="color:#444;font-size:12px;">Не вдалось завантажити список</span>';
    });

  dropZone.appendChild(wrap);
}

// ── Electron: load pharmacy log from GitHub via modal ────────────────────

function showGitHubBrowserModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#252526;border:1px solid #444;border-radius:8px;padding:24px 28px;width:420px;max-width:94vw;display:flex;flex-direction:column;gap:14px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;font-weight:bold;color:#ccc;';
  title.textContent = '☁️ Завантажити лог з GitHub';
  box.appendChild(title);

  // Manual ID input
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;';
  const input = document.createElement('input');
  input.placeholder = 'ID аптеки (CL2, CL212...)';
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;background:#1e1e1e;border:1px solid #555;color:#ccc;padding:7px 10px;border-radius:4px;font-family:inherit;font-size:13px;outline:none;';
  const goBtn = document.createElement('button');
  goBtn.textContent = 'Відкрити';
  goBtn.style.cssText = 'background:#0e639c;border:none;color:#fff;padding:7px 14px;border-radius:4px;cursor:pointer;font-family:inherit;';
  row.appendChild(input); row.appendChild(goBtn);
  box.appendChild(row);

  const listTitle = document.createElement('div');
  listTitle.style.cssText = 'font-size:11px;color:#555;';
  listTitle.textContent = 'Доступні аптеки:';
  box.appendChild(listTitle);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;min-height:32px;';
  list.innerHTML = '<span style="color:#555;font-size:12px;">Завантаження...</span>';
  box.appendChild(list);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:#666;min-height:16px;';
  box.appendChild(status);

  async function doLoad(id) {
    overlay.remove();
    status.textContent = '';
    const statsEl = document.getElementById('stats');
    if (statsEl) statsEl.textContent = `⏳ Завантаження ${id}...`;
    try {
      const url = `${RAW_BASE}${encodeURIComponent(id)}.log`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Лог "${id}" не знайдено (HTTP ${res.status})`);
      const content = await res.text();
      loadText(content, `${id}.log`);
      document.title = `Loki — ${id}`;
    } catch (e) {
      if (statsEl) statsEl.textContent = `❌ ${e.message}`;
    }
  }

  goBtn.addEventListener('click', () => { const id = input.value.trim(); if (id) doLoad(id); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click(); });

  // Fetch list + labels
  Promise.all([fetch(API_FILES).then(r => r.json()), fetchIndex()])
    .then(([files, index]) => {
      const logFiles = Array.isArray(files) ? files.filter(f => f.name.endsWith('.log')) : [];
      buildChips(list, logFiles, index, id => doLoad(id));
    })
    .catch(() => { list.innerHTML = '<span style="color:#555;font-size:12px;">Не вдалось завантажити список</span>'; });

  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 50);
}

document.addEventListener('DOMContentLoaded', async () => {
  await init();

  // Wire up Send button (Electron only)
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    if (!window.electronAPI) {
      shareBtn.style.display = 'none'; // hidden in web mode
    } else {
      shareBtn.addEventListener('click', () => {
        if (!allLines.length) return;
        showPushDialog();
      });
    }
  }

  // Wire up "З GitHub" button (Electron only)
  const fetchBtn = document.getElementById('fetch-btn');
  if (fetchBtn) {
    if (!window.electronAPI) {
      fetchBtn.style.display = 'none'; // visible only in Electron
    } else {
      fetchBtn.addEventListener('click', () => showGitHubBrowserModal());
    }
  }

  // Web mode: load by ?pharmacy=ID or show browser
  await loadFromUrlParams();
});
