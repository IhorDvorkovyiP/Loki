import { extractJsonBlocks } from './parser.js';

// ── DOM helpers ─────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function span(cls, text) {
  return el('span', cls, text);
}

// ── renderJsonValue ──────────────────────────────────────────────────────

/**
 * Render a JS value as a DOM node (recursive, collapsible for objects/arrays).
 * Nested stringified JSON inside strings is parsed and rendered recursively (depth < 6).
 */
export function renderJsonValue(value, depth = 0, isLast = true, keyName = null) {
  const indent = depth * 14;

  if (value === null)
    return renderScalarLine(keyName, span('j-null', 'null'), isLast, indent);
  if (typeof value === 'boolean')
    return renderScalarLine(keyName, span('j-bool', String(value)), isLast, indent);
  if (typeof value === 'number')
    return renderScalarLine(keyName, span('j-num', String(value)), isLast, indent);

  if (typeof value === 'string') {
    // Try to parse nested JSON string
    if (depth < 6 && (value.trimStart().startsWith('{') || value.trimStart().startsWith('['))) {
      try {
        const nested = JSON.parse(value);
        const wrapper = el('div', 'json-nested-str');
        if (keyName !== null) {
          const keyLine = el('div', 'json-line');
          keyLine.style.paddingLeft = indent + 'px';
          keyLine.appendChild(span('j-key', JSON.stringify(keyName) + ': '));
          keyLine.appendChild(span('j-str j-nested-indicator', '(nested JSON) ↓'));
          wrapper.appendChild(keyLine);
        }
        wrapper.appendChild(renderJsonValue(nested, depth, isLast, null));
        return wrapper;
      } catch (_) {}
    }
    return renderScalarLine(keyName, span('j-str', JSON.stringify(value)), isLast, indent);
  }

  if (Array.isArray(value)) return renderCollapsible(value, depth, isLast, keyName, true);
  if (typeof value === 'object') return renderCollapsible(value, depth, isLast, keyName, false);

  return renderScalarLine(keyName, span('j-plain', String(value)), isLast, indent);
}

function renderScalarLine(keyName, valueNode, isLast, indent) {
  const line = el('div', 'json-line');
  line.style.paddingLeft = indent + 'px';
  if (keyName !== null) line.appendChild(span('j-key', JSON.stringify(keyName) + ': '));
  line.appendChild(valueNode);
  if (!isLast) line.appendChild(span('j-comma', ','));
  return line;
}

function renderCollapsible(value, depth, isLast, keyName, isArray) {
  const indent      = depth * 14;
  const entries     = isArray ? value : Object.entries(value);
  const count       = isArray ? value.length : Object.keys(value).length;
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';
  const typeLabel   = isArray ? `${count} items` : `${count} keys`;

  const container = el('div', 'json-node');

  // Opening line: ▾ [key:] {
  const openLine = el('div', 'json-line');
  openLine.style.paddingLeft = indent + 'px';
  const toggle = span('json-toggle', '− ');
  toggle.dataset.collapsed = 'false';
  openLine.appendChild(toggle);
  if (keyName !== null) openLine.appendChild(span('j-key', JSON.stringify(keyName) + ': '));
  openLine.appendChild(span('j-bracket', openBracket));
  const summary = span('json-summary', '…' + typeLabel);
  summary.style.display = 'none';
  openLine.appendChild(summary);
  container.appendChild(openLine);

  // Children
  const children = el('div', 'json-children');
  if (isArray) {
    for (let i = 0; i < value.length; i++)
      children.appendChild(renderJsonValue(value[i], depth + 1, i === value.length - 1, null));
  } else {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++)
      children.appendChild(renderJsonValue(value[keys[i]], depth + 1, i === keys.length - 1, keys[i]));
  }
  container.appendChild(children);

  // Closing line: }
  const closeLine = el('div', 'json-line');
  closeLine.style.paddingLeft = indent + 'px';
  closeLine.appendChild(span('j-bracket', closeBracket));
  if (!isLast) closeLine.appendChild(span('j-comma', ','));
  container.appendChild(closeLine);

  function doToggle(collapse) {
    toggle.dataset.collapsed = String(collapse);
    toggle.textContent = collapse ? '+ ' : '− ';
    children.classList.toggle('collapsed', collapse);
    summary.style.display = collapse ? 'inline' : 'none';
    closeLine.style.display = collapse ? 'none' : 'block';
  }

  toggle.addEventListener('click',  (e) => { e.stopPropagation(); doToggle(toggle.dataset.collapsed === 'false'); });
  summary.addEventListener('click', (e) => { e.stopPropagation(); doToggle(false); });
  openLine.addEventListener('click', (e) => { if (e.target === openLine) doToggle(toggle.dataset.collapsed === 'false'); });

  return container;
}

// ── sortJsonDeep ─────────────────────────────────────────────────────────

/**
 * Recursively sort all object keys alphabetically.
 * Arrays are preserved in their original order.
 */
function sortJsonDeep(v) {
  if (Array.isArray(v)) return v.map(sortJsonDeep);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v).sort().map(k => [k, sortJsonDeep(v[k])])
    );
  return v;
}

// ── renderJsonFromRaw ────────────────────────────────────────────────────

/**
 * Given a raw log line string, extract JSON blocks and render them as
 * collapsible DOM nodes. Non-JSON text is shown as-is.
 * @param {string} rawLine
 * @param {{ sorted?: boolean }} options  — sorted=true sorts all keys alphabetically
 */
export function renderJsonFromRaw(rawLine, { sorted = false } = {}) {
  const root   = el('div', 'json-root');
  const blocks = extractJsonBlocks(rawLine);

  if (!blocks.length) {
    const pre = el('div', 'json-prefix');
    pre.textContent = rawLine;
    root.appendChild(pre);
    return root;
  }

  let cursor = 0;
  for (const blk of blocks) {
    if (blk.start > cursor) {
      const prefix = rawLine.slice(cursor, blk.start);
      if (prefix.trim()) {
        const p = el('div', 'json-prefix');
        p.textContent = prefix;
        root.appendChild(p);
      }
    }
    try {
      const parsed   = JSON.parse(blk.raw);
      const toRender = sorted ? sortJsonDeep(parsed) : parsed;
      const label    = el('span', 'blk-label', Array.isArray(toRender) ? 'array' : 'object');
      root.appendChild(label);
      root.appendChild(renderJsonValue(toRender, 0, true, null));
    } catch (_) {
      const p = el('div', 'json-prefix');
      p.textContent = blk.raw;
      root.appendChild(p);
    }
    cursor = blk.end;
  }

  if (cursor < rawLine.length) {
    const suffix = rawLine.slice(cursor);
    if (suffix.trim()) {
      const p = el('div', 'json-prefix');
      p.textContent = suffix;
      root.appendChild(p);
    }
  }

  return root;
}

// ── setAllCollapsed ──────────────────────────────────────────────────────

/**
 * Expand (collapsed=false) or collapse (collapsed=true) all JSON nodes.
 */
export function setAllCollapsed(container, collapsed) {
  for (const toggle of container.querySelectorAll('.json-toggle[data-collapsed]')) {
    if ((toggle.dataset.collapsed === 'true') !== collapsed) toggle.click();
  }
}

// ── highlightSearch ──────────────────────────────────────────────────────

/**
 * Remove existing <mark> elements, then wrap all occurrences of searchText
 * in <mark> (case-insensitive).
 */
export function highlightSearch(container, searchText) {
  for (const mark of Array.from(container.querySelectorAll('mark'))) {
    mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
    mark.parentNode.normalize();
  }
  if (!searchText || !searchText.trim()) return;
  highlightTextNodes(container, searchText.toLowerCase());
}

function highlightTextNodes(node, needle) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text  = node.textContent;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) return;
    const frag = document.createDocumentFragment();
    let pos = 0;
    while (idx !== -1) {
      if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      pos = idx + needle.length;
      idx = lower.indexOf(needle, pos);
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE') {
    // json-line: кома і значення в різних span-ах — шукаємо по всьому рядку
    if (node.classList && node.classList.contains('json-line')) {
      highlightAcrossLine(node, needle);
      return;
    }
    for (const child of Array.from(node.childNodes)) highlightTextNodes(child, needle);
  }
}

// Збирає всі текстові ноди в рядку, будує "віртуальний" рядок,
// знаходить збіги, маркує відповідні частини навіть якщо вони в різних span-ах.
function highlightAcrossLine(lineEl, needle) {
  // Зібрати всі листові текстові ноди
  const textNodes = [];
  (function collect(n) {
    if (n.nodeType === Node.TEXT_NODE) { textNodes.push(n); return; }
    if (n.nodeType === Node.ELEMENT_NODE) for (const c of n.childNodes) collect(c);
  })(lineEl);

  // Побудувати віртуальний рядок з відступами
  let str = '';
  const ranges = []; // { node, start, len }
  for (const tn of textNodes) {
    ranges.push({ node: tn, start: str.length, len: tn.textContent.length });
    str += tn.textContent;
  }

  const lower = str.toLowerCase();
  if (lower.indexOf(needle) === -1) return; // швидка перевірка

  // Для кожної текстової ноди — які частини потрапляють під маркування
  for (const { node, start, len } of ranges) {
    const nodeEnd = start + len;
    const segments = []; // { text, isMark }
    let pos = 0;
    let idx = lower.indexOf(needle, 0);

    while (idx !== -1) {
      const matchEnd = idx + needle.length;
      const overlapStart = Math.max(start, idx) - start;      // відносно ноди
      const overlapEnd   = Math.min(nodeEnd, matchEnd) - start;

      if (overlapEnd > overlapStart && overlapStart < len) {
        if (overlapStart > pos) segments.push({ text: node.textContent.slice(pos, overlapStart), isMark: false });
        segments.push({ text: node.textContent.slice(overlapStart, overlapEnd), isMark: true });
        pos = overlapEnd;
      }
      idx = lower.indexOf(needle, idx + 1);
    }

    if (!segments.some(s => s.isMark)) continue;
    if (pos < len) segments.push({ text: node.textContent.slice(pos), isMark: false });

    const frag = document.createDocumentFragment();
    for (const seg of segments) {
      if (seg.isMark) { const m = document.createElement('mark'); m.textContent = seg.text; frag.appendChild(m); }
      else frag.appendChild(document.createTextNode(seg.text));
    }
    node.parentNode.replaceChild(frag, node);
  }
}
