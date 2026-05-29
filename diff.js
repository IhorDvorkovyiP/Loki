// ── Diff window ───────────────────────────────────────────────────────────

let savedLines  = [];
let leftIdx  = 0;
let rightIdx = 1;

const leftSelect  = document.getElementById('left-select');
const rightSelect = document.getElementById('right-select');
const leftMeta    = document.getElementById('left-meta');
const rightMeta   = document.getElementById('right-meta');
const leftContent  = document.getElementById('left-content');
const rightContent = document.getElementById('right-content');
const emptyMsg     = document.getElementById('empty-msg');
const diffStats    = document.getElementById('diff-stats');
const workspace    = document.getElementById('diff-workspace');

// ── Helpers ───────────────────────────────────────────────────────────────

function sortJsonDeep(v) {
  if (Array.isArray(v)) return v.map(sortJsonDeep);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortJsonDeep(v[k])]));
  return v;
}

// ── JSON extraction ───────────────────────────────────────────────────────

function extractJsonBlocks(str) {
  const blocks = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '{' || str[i] === '[') {
      const start = i;
      const stack = [];
      let inStr = false, slash = false;
      for (; i < str.length; i++) {
        const c = str[i];
        if (slash) { slash = false; continue; }
        if (c === '\\' && inStr) { slash = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') stack.push(c);
        else if ((c === '}' || c === ']') && stack.pop() === undefined) break;
        if (!stack.length && (c === '}' || c === ']')) {
          blocks.push({ raw: str.slice(start, i + 1) });
          i++;
          break;
        }
      }
    } else { i++; }
  }
  return blocks;
}

function getJsonText(line) {
  const raw = line.raw || '';
  // Try to extract JSON block
  const blocks = extractJsonBlocks(raw);
  if (blocks.length > 0) {
    try {
      return JSON.stringify(sortJsonDeep(JSON.parse(blocks[0].raw)), null, 2);
    } catch (_) {}
  }
  // Fallback: use body
  const body = line.body || raw;
  try {
    return JSON.stringify(sortJsonDeep(JSON.parse(body)), null, 2);
  } catch (_) {
    return body;
  }
}

// ── LCS diff ─────────────────────────────────────────────────────────────

function buildDiff(a, b) {
  // For large inputs use a quick approximation
  if (a.length > 600 || b.length > 600) {
    // Trim to first 300 lines each for responsiveness
    const ta = a.slice(0, 300), tb = b.slice(0, 300);
    return buildDiffLCS(ta, tb).concat(
      a.slice(300).map(t => ({ type: 'del', text: t })),
      b.slice(300).map(t => ({ type: 'add', text: t })),
    );
  }
  return buildDiffLCS(a, b);
}

function buildDiffLCS(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Int32Array(n + 1);
  }
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      result.unshift({ type: 'same', text: a[i-1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.unshift({ type: 'add', text: b[j-1] });
      j--;
    } else {
      result.unshift({ type: 'del', text: a[i-1] });
      i--;
    }
  }
  return result;
}

// ── Side-by-side layout ───────────────────────────────────────────────────

function sideBySide(a, b) {
  const diff = buildDiff(a, b);
  const left = [], right = [];

  let di = 0;
  while (di < diff.length) {
    const item = diff[di];
    if (item.type === 'same') {
      left.push({ text: item.text, cls: '' });
      right.push({ text: item.text, cls: '' });
      di++;
    } else {
      // Collect contiguous del/add block
      const dels = [], adds = [];
      while (di < diff.length && diff[di].type === 'del') { dels.push(diff[di].text); di++; }
      while (di < diff.length && diff[di].type === 'add') { adds.push(diff[di].text); di++; }
      const maxLen = Math.max(dels.length, adds.length);
      for (let k = 0; k < maxLen; k++) {
        left.push(k < dels.length
          ? { text: dels[k], cls: 'diff-del' }
          : { text: '',      cls: 'diff-placeholder' });
        right.push(k < adds.length
          ? { text: adds[k], cls: 'diff-add' }
          : { text: '',      cls: 'diff-placeholder' });
      }
    }
  }
  return { left, right };
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderPanel(container, lines) {
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const { text, cls } of lines) {
    const div = document.createElement('div');
    div.className = 'diff-line' + (cls ? ' ' + cls : '');
    div.textContent = text;
    frag.appendChild(div);
  }
  container.appendChild(frag);
}

function renderDiff() {
  if (!savedLines.length) return;

  const L = savedLines[leftIdx];
  const R = savedLines[rightIdx];

  // Meta
  leftMeta.innerHTML  = '';
  rightMeta.innerHTML = '';
  const mkMeta = (el, line) => {
    const b = document.createElement('b');
    b.textContent = line.time + '  ';
    el.appendChild(b);
    el.appendChild(document.createTextNode(
      [line.trace, line.comp, line.dir].filter(Boolean).join('  ')
    ));
  };
  mkMeta(leftMeta, L);
  mkMeta(rightMeta, R);

  // Diff
  const leftText  = getJsonText(L);
  const rightText = getJsonText(R);
  const leftLines  = leftText.split('\n');
  const rightLines = rightText.split('\n');

  const { left, right } = sideBySide(leftLines, rightLines);

  renderPanel(leftContent,  left);
  renderPanel(rightContent, right);

  // Stats
  const dels = left.filter(l  => l.cls === 'diff-del').length;
  const adds = right.filter(l => l.cls === 'diff-add').length;
  if (dels === 0 && adds === 0) {
    diffStats.textContent = '✓ Однакові';
    diffStats.style.color = '#6ac26a';
  } else {
    diffStats.textContent = `−${dels}  +${adds}`;
    diffStats.style.color = '#888';
  }
}

// ── Selects ───────────────────────────────────────────────────────────────

function formatLabel(line, i) {
  const t = line.time ? line.time.split(' ')[1] : '';
  return `#${i + 1}  ${[t, line.comp, line.dir].filter(Boolean).join('  ')}  ${(line.body || '').slice(0, 40)}`;
}

function buildSelects() {
  [leftSelect, rightSelect].forEach((sel, si) => {
    sel.innerHTML = '';
    savedLines.forEach((line, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = formatLabel(line, i);
      sel.appendChild(opt);
    });
    sel.value = si === 0 ? leftIdx : rightIdx;
  });
}

// ── Sync scroll ───────────────────────────────────────────────────────────

function initSyncScroll() {
  let lock = false;
  leftContent.addEventListener('scroll', () => {
    if (lock) return; lock = true;
    rightContent.scrollTop = leftContent.scrollTop;
    rightContent.scrollLeft = leftContent.scrollLeft;
    lock = false;
  }, { passive: true });
  rightContent.addEventListener('scroll', () => {
    if (lock) return; lock = true;
    leftContent.scrollTop  = rightContent.scrollTop;
    leftContent.scrollLeft = rightContent.scrollLeft;
    lock = false;
  }, { passive: true });
}

// ── Init ──────────────────────────────────────────────────────────────────

function loadData(data) {
  savedLines = data || [];
  if (savedLines.length < 2) {
    emptyMsg.classList.add('show');
    workspace.style.display = 'none';
    return;
  }
  emptyMsg.classList.remove('show');
  workspace.style.display = 'flex';
  leftIdx  = 0;
  rightIdx = Math.min(1, savedLines.length - 1);
  buildSelects();
  renderDiff();
}

document.addEventListener('DOMContentLoaded', () => {
  initSyncScroll();

  leftSelect.addEventListener('change', () => {
    leftIdx = +leftSelect.value;
    renderDiff();
  });
  rightSelect.addEventListener('change', () => {
    rightIdx = +rightSelect.value;
    renderDiff();
  });

  if (window.electronAPI?.onLoadSaved) {
    window.electronAPI.onLoadSaved(loadData);
  }
});
