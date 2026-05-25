import { parseLines } from './parser.js';
import {
  renderJsonFromRaw,
  setAllCollapsed,
  highlightSearch,
  renderDiff,
} from './json-viewer.js';

// ── Constants ────────────────────────────────────────────────────────────
const ROW_H  = 22;
const BUFFER = 60;

// ── State ────────────────────────────────────────────────────────────────
let allLines      = [];
let filteredLines = [];
let activeLevels  = new Set(['INFO', 'ERROR', 'DEBUG', 'WARN']);
let activeComps   = new Set(['HTTP', 'SLAVE', 'BUS', 'OTHER']);
let searchQuery   = '';
let searchRe      = null;
let traceFilter   = '';
let sortBy        = 'time';
let sortDir       = 'asc';
let selectedIdx   = -1;   // index into filteredLines
let pinnedLine    = null;
let activeTab     = 'body';
let bodySearchQuery = '';
let rowTops       = [];
let totalH        = 0;
let currentFilePath = null;
let liveMode      = false;
let rafId         = null;

// Solo-mode tracking for filter buttons
let soloLevel = null;
let soloComp  = null;

// ── DOM refs ─────────────────────────────────────────────────────────────
const logContainer  = document.getElementById('log-container');
const vsSpacer      = document.getElementById('vs-spacer');
const detailMeta    = document.getElementById('detail-meta');
const detailContent = document.getElementById('detail-content');
const detailToolbar = document.getElementById('detail-toolbar');
const statsEl       = document.getElementById('stats');
const traceBar      = document.getElementById('trace-bar');
const traceVal      = document.getElementById('trace-val');
const dropZone      = document.getElementById('drop-zone');
const workspace     = document.getElementById('workspace');
const searchInput   = document.getElementById('search');
const bodySearch    = document.getElementById('body-search');
const openBtn       = document.getElementById('open-btn');
const liveBtn       = document.getElementById('live-btn');
const pinBtn        = document.getElementById('pin-btn');
const expandAllBtn  = document.getElementById('expand-all-btn');
const collapseAllBtn = document.getElementById('collapse-all-btn');
const listPane      = document.getElementById('list-pane');
const resizeHandle  = document.getElementById('resize-handle');
const traceClear    = document.getElementById('trace-clear');
const listHeader    = document.getElementById('list-header');

// ── Filtering & Sorting ──────────────────────────────────────────────────

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

function recomputeFiltered() {
  filteredLines = allLines.filter(l =>
    activeLevels.has(l.level) &&
    activeComps.has(l.comp) &&
    (!traceFilter || l.trace === traceFilter) &&
    matchesSearch(l)
  );

  // Sort
  filteredLines.sort((a, b) => {
    let va, vb;
    if (sortBy === 'level') {
      va = a.level; vb = b.level;
    } else if (sortBy === 'comp') {
      va = a.comp; vb = b.comp;
    } else {
      // 'time' — preserve stable order (use original idx)
      va = a.idx; vb = b.idx;
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ?  1 : -1;
    return a.idx - b.idx;
  });

  // Recompute row positions
  rowTops = [];
  for (let i = 0; i < filteredLines.length; i++) {
    rowTops.push(i * ROW_H);
  }
  totalH = filteredLines.length * ROW_H;
  vsSpacer.style.height = totalH + 'px';

  statsEl.textContent = `${filteredLines.length} / ${allLines.length} рядків`;
}

// ── Virtual scroll rendering ──────────────────────────────────────────────

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
  const end   = Math.min(filteredLines.length - 1,
    Math.ceil((scrollTop + clientHeight) / ROW_H) + BUFFER);

  // Remove rows outside viewport
  for (const [idx, rowEl] of renderedRows) {
    if (idx < start || idx > end) {
      rowEl.remove();
      renderedRows.delete(idx);
    }
  }

  // Add new rows
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
  row.style.top = rowTops[filtIdx] + 'px';

  const tTime  = document.createElement('span'); tTime.className  = 'col-time';  tTime.textContent  = line.time;
  const tLevel = document.createElement('span'); tLevel.className = 'col-level'; tLevel.textContent = line.level;
  const tTrace = document.createElement('span'); tTrace.className = 'col-trace'; tTrace.textContent = line.trace;
  const tComp  = document.createElement('span'); tComp.className  = 'col-comp';  tComp.textContent  = line.comp;
  const tDir   = document.createElement('span'); tDir.className   = 'col-dir';   tDir.textContent   = line.dir;
  const tBody  = document.createElement('span'); tBody.className  = 'col-body';  tBody.textContent  = firstLine(line.body);

  row.appendChild(tTime);
  row.appendChild(tLevel);
  row.appendChild(tTrace);
  row.appendChild(tComp);
  row.appendChild(tDir);
  row.appendChild(tBody);

  // Row click → select & show detail
  row.addEventListener('click', () => {
    selectedIdx = filtIdx;
    refreshSelectedClass();
    showDetail(line);
  });

  // Trace click → filter by trace
  tTrace.addEventListener('click', (e) => {
    e.stopPropagation();
    if (line.trace) setTraceFilter(line.trace);
  });

  return row;
}

function firstLine(str) {
  return str ? str.split('\n')[0] : '';
}

function refreshSelectedClass() {
  for (const [idx, rowEl] of renderedRows) {
    if (idx === selectedIdx) rowEl.classList.add('selected');
    else rowEl.classList.remove('selected');
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

  detailMeta.innerHTML = '';
  const metaB = document.createElement('b');
  metaB.textContent = line.time + '  ';
  detailMeta.appendChild(metaB);
  detailMeta.appendChild(document.createTextNode(line.trace + '  ' + line.comp + '  ' + line.dir));

  renderDetailContent(line);
}

function renderDetailContent(line) {
  detailContent.innerHTML = '';
  if (!line) return;

  if (activeTab === 'body') {
    const dom = renderJsonFromRaw(line.raw);
    detailContent.appendChild(dom);
  } else if (activeTab === 'diff') {
    if (!pinnedLine) {
      const msg = document.createElement('div');
      msg.className = 'diff-header';
      msg.textContent = 'Натисніть 📌 Pin для вибору рядка для порівняння, потім оберіть інший рядок.';
      detailContent.appendChild(msg);
    } else if (pinnedLine === line) {
      const msg = document.createElement('div');
      msg.className = 'diff-header';
      msg.textContent = 'Оберіть інший рядок для порівняння з зафіксованим.';
      detailContent.appendChild(msg);
    } else {
      const dom = renderDiff(pinnedLine, line);
      detailContent.appendChild(dom);
    }
  }

  if (bodySearchQuery) {
    highlightSearch(detailContent, bodySearchQuery);
  }
}

function currentLine() {
  if (selectedIdx < 0 || selectedIdx >= filteredLines.length) return null;
  return filteredLines[selectedIdx];
}

// ── Trace filter ──────────────────────────────────────────────────────────

function setTraceFilter(trace) {
  traceFilter = trace;
  traceVal.textContent = trace;
  traceBar.classList.add('show');
  recomputeFiltered();
  clearRendered();
  scheduleRender();
}

function clearTraceFilter() {
  traceFilter = '';
  traceBar.classList.remove('show');
  recomputeFiltered();
  clearRendered();
  scheduleRender();
}

// ── File loading ──────────────────────────────────────────────────────────

function loadText(text, filePath) {
  allLines = parseLines(text);
  currentFilePath = filePath || null;
  selectedIdx = -1;
  pinnedLine  = null;
  pinBtn.classList.remove('pinned');
  detailMeta.innerHTML = '';
  detailContent.innerHTML = '';
  clearTraceFilter();
  recomputeFiltered();
  clearRendered();
  scheduleRender();
  showWorkspace();
}

function showWorkspace() {
  dropZone.classList.remove('visible');
  workspace.style.display = 'flex';
}

function showDropZone() {
  workspace.style.display = 'none';
  dropZone.classList.add('visible');
}

async function openFileDialog() {
  if (window.electronAPI) {
    const filePath = await window.electronAPI.openFile();
    if (!filePath) return;
    const text = await window.electronAPI.readFile(filePath);
    loadText(text, filePath);
  } else {
    // Browser fallback
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Log files', accept: { 'text/plain': ['.log', '.txt'] } }],
      });
      const file = await handle.getFile();
      const text = await file.text();
      loadText(text, file.name);
    } catch (_) {
      // User cancelled
    }
  }
}

// ── Live mode ─────────────────────────────────────────────────────────────

function setLiveMode(on) {
  liveMode = on;
  if (on) {
    liveBtn.classList.add('live-on');
    liveBtn.textContent = '⟳ Live ON';
    if (currentFilePath && window.electronAPI) {
      window.electronAPI.watchFile(currentFilePath, (newText) => {
        const wasAtBottom = logContainer.scrollTop + logContainer.clientHeight >= totalH - ROW_H * 3;
        loadText(newText, currentFilePath);
        if (wasAtBottom) scrollToBottom();
      });
    }
  } else {
    liveBtn.classList.remove('live-on');
    liveBtn.textContent = '⟳ Live';
    if (window.electronAPI) window.electronAPI.unwatchFile();
  }
}

function scrollToBottom() {
  logContainer.scrollTop = totalH;
}

// ── Sorting ───────────────────────────────────────────────────────────────

function setSortBy(col) {
  if (sortBy === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortBy  = col;
    sortDir = 'asc';
  }
  updateSortIndicators();
  recomputeFiltered();
  clearRendered();
  scheduleRender();
}

function updateSortIndicators() {
  for (const th of listHeader.querySelectorAll('.sortable')) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortBy) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  }
}

// ── Filter buttons ────────────────────────────────────────────────────────

function handleLevelToggle(btn) {
  const lvl = btn.dataset.level;
  if (soloLevel === lvl) {
    // Second click on solo level → restore all
    activeLevels = new Set(['INFO', 'ERROR', 'DEBUG', 'WARN']);
    soloLevel = null;
    document.querySelectorAll('.toggle-btn[data-level]').forEach(b => b.classList.add('active'));
  } else if (activeLevels.size === 4 || soloLevel) {
    // Solo this level
    activeLevels = new Set([lvl]);
    soloLevel = lvl;
    document.querySelectorAll('.toggle-btn[data-level]').forEach(b => {
      b.classList.toggle('active', b.dataset.level === lvl);
    });
  } else {
    // Normal toggle
    if (activeLevels.has(lvl)) {
      activeLevels.delete(lvl);
      btn.classList.remove('active');
    } else {
      activeLevels.add(lvl);
      btn.classList.add('active');
    }
  }
  recomputeFiltered();
  clearRendered();
  scheduleRender();
}

function handleCompToggle(btn) {
  const comp = btn.dataset.comp;
  if (soloComp === comp) {
    activeComps = new Set(['HTTP', 'SLAVE', 'BUS', 'OTHER']);
    soloComp = null;
    document.querySelectorAll('.toggle-btn[data-comp]').forEach(b => b.classList.add('active'));
  } else if (activeComps.size === 4 || soloComp) {
    activeComps = new Set([comp]);
    soloComp = comp;
    document.querySelectorAll('.toggle-btn[data-comp]').forEach(b => {
      b.classList.toggle('active', b.dataset.comp === comp);
    });
  } else {
    if (activeComps.has(comp)) {
      activeComps.delete(comp);
      btn.classList.remove('active');
    } else {
      activeComps.add(comp);
      btn.classList.add('active');
    }
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
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW  = Math.max(350, Math.min(window.innerWidth - 350, startW + delta));
    listPane.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      resizeHandle.classList.remove('dragging');
    }
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
    const text = await file.text();
    loadText(text, file.path || file.name);
  });
}

// ── Body search debounce ──────────────────────────────────────────────────

let bodySearchTimer = null;
function scheduleBodySearch() {
  if (bodySearchTimer) clearTimeout(bodySearchTimer);
  bodySearchTimer = setTimeout(() => {
    bodySearchQuery = bodySearch.value.trim();
    highlightSearch(detailContent, bodySearchQuery);
  }, 200);
}

// ── Init ──────────────────────────────────────────────────────────────────

function init() {
  // Show drop zone initially
  workspace.style.display = 'none';
  dropZone.classList.add('visible');

  initResizeHandle();
  initDragDrop();

  // Scroll listener
  logContainer.addEventListener('scroll', scheduleRender, { passive: true });

  // Open file
  openBtn.addEventListener('click', openFileDialog);

  // Menu open (Electron)
  if (window.electronAPI) {
    window.electronAPI.onMenuOpen(() => openFileDialog());
  }

  // Live toggle
  liveBtn.addEventListener('click', () => setLiveMode(!liveMode));

  // Main search
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    searchRe    = buildSearchRe(searchQuery);
    recomputeFiltered();
    clearRendered();
    scheduleRender();
  });

  // Level filter buttons
  document.querySelectorAll('.toggle-btn[data-level]').forEach(btn => {
    btn.addEventListener('click', () => handleLevelToggle(btn));
  });

  // Comp filter buttons
  document.querySelectorAll('.toggle-btn[data-comp]').forEach(btn => {
    btn.addEventListener('click', () => handleCompToggle(btn));
  });

  // Trace clear
  traceClear.addEventListener('click', clearTraceFilter);

  // Sort headers
  for (const th of listHeader.querySelectorAll('.sortable')) {
    th.addEventListener('click', () => setSortBy(th.dataset.sort));
  }

  // Detail tabs
  document.querySelectorAll('.dtab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dtab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      const line = currentLine();
      if (line) renderDetailContent(line);
    });
  });

  // Expand / collapse all
  expandAllBtn.addEventListener('click', () => setAllCollapsed(detailContent, false));
  collapseAllBtn.addEventListener('click', () => setAllCollapsed(detailContent, true));

  // Pin button
  pinBtn.addEventListener('click', () => {
    const line = currentLine();
    if (!line) return;
    if (pinnedLine === line) {
      pinnedLine = null;
      pinBtn.classList.remove('pinned');
    } else {
      pinnedLine = line;
      pinBtn.classList.add('pinned');
    }
    if (activeTab === 'diff') renderDetailContent(line);
  });

  // Body search
  bodySearch.addEventListener('input', scheduleBodySearch);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!filteredLines.length) return;
      e.preventDefault();
      let next = selectedIdx + (e.key === 'ArrowDown' ? 1 : -1);
      next = Math.max(0, Math.min(filteredLines.length - 1, next));
      selectedIdx = next;
      refreshSelectedClass();
      showDetail(filteredLines[next]);
      // Scroll into view
      const rowTop = rowTops[next];
      if (rowTop < logContainer.scrollTop) logContainer.scrollTop = rowTop;
      if (rowTop + ROW_H > logContainer.scrollTop + logContainer.clientHeight) {
        logContainer.scrollTop = rowTop + ROW_H - logContainer.clientHeight;
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
