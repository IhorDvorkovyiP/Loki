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
 * Handles nested stringified JSON in strings (depth < 6).
 *
 * @param {*} value
 * @param {number} depth
 * @param {boolean} isLast - whether this is the last key in parent (omit trailing comma)
 * @param {string|null} keyName - key label, null if rendering as standalone value
 * @returns {HTMLElement}
 */
export function renderJsonValue(value, depth = 0, isLast = true, keyName = null) {
  const indent = depth * 14;

  if (value === null) {
    return renderScalarLine(keyName, span('j-null', 'null'), isLast, indent);
  }
  if (typeof value === 'boolean') {
    return renderScalarLine(keyName, span('j-bool', String(value)), isLast, indent);
  }
  if (typeof value === 'number') {
    return renderScalarLine(keyName, span('j-num', String(value)), isLast, indent);
  }
  if (typeof value === 'string') {
    // Try to parse nested JSON string (depth guard: 0-based, max 6 levels deep)
    if (depth < 6 && (value.trimStart().startsWith('{') || value.trimStart().startsWith('['))) {
      try {
        const nested = JSON.parse(value);
        // It parsed — render as nested expandable block
        const wrapper = el('div', 'json-nested-str');
        // Key label line: "key": (nested JSON below)
        if (keyName !== null) {
          const keyLine = el('div', 'json-line');
          keyLine.style.paddingLeft = indent + 'px';
          keyLine.appendChild(span('j-key', JSON.stringify(keyName) + ': '));
          keyLine.appendChild(span('j-str j-nested-indicator', '(nested JSON) ↓'));
          wrapper.appendChild(keyLine);
        }
        const nested_el = renderJsonValue(nested, depth, isLast, null);
        // Adjust indentation of nested block
        wrapper.appendChild(nested_el);
        return wrapper;
      } catch (_) {
        // Not valid JSON — fall through to string rendering
      }
    }
    return renderScalarLine(keyName, span('j-str', JSON.stringify(value)), isLast, indent);
  }

  if (Array.isArray(value)) {
    return renderCollapsible(value, depth, isLast, keyName, true);
  }
  if (typeof value === 'object') {
    return renderCollapsible(value, depth, isLast, keyName, false);
  }

  // Fallback
  return renderScalarLine(keyName, span('j-plain', String(value)), isLast, indent);
}

function renderScalarLine(keyName, valueNode, isLast, indent) {
  const line = el('div', 'json-line');
  line.style.paddingLeft = indent + 'px';
  if (keyName !== null) {
    line.appendChild(span('j-key', JSON.stringify(keyName) + ': '));
  }
  line.appendChild(valueNode);
  if (!isLast) line.appendChild(span('j-comma', ','));
  return line;
}

function renderCollapsible(value, depth, isLast, keyName, isArray) {
  const indent = depth * 14;
  const childIndent = (depth + 1) * 14;
  const openBracket  = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';
  const entries = isArray ? value : Object.entries(value);
  const count   = isArray ? value.length : Object.keys(value).length;
  const typeLabel = isArray ? `${count} items` : `${count} keys`;

  // Container for the whole node
  const container = el('div', 'json-node');

  // ── Opening line: ▾ [keyName:] {
  const openLine = el('div', 'json-line');
  openLine.style.paddingLeft = indent + 'px';

  const toggle = span('json-toggle', '▾ ');
  toggle.dataset.collapsed = 'false';
  openLine.appendChild(toggle);

  if (keyName !== null) {
    openLine.appendChild(span('j-key', JSON.stringify(keyName) + ': '));
  }
  openLine.appendChild(span('j-bracket', openBracket));

  // Collapsed summary (hidden when expanded)
  const summary = span('json-summary', '…' + typeLabel);
  summary.style.display = 'none';
  openLine.appendChild(summary);

  container.appendChild(openLine);

  // ── Children container
  const children = el('div', 'json-children');
  if (isArray) {
    for (let i = 0; i < value.length; i++) {
      children.appendChild(renderJsonValue(value[i], depth + 1, i === value.length - 1, null));
    }
  } else {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      children.appendChild(renderJsonValue(value[keys[i]], depth + 1, i === keys.length - 1, keys[i]));
    }
  }
  container.appendChild(children);

  // ── Closing line: }
  const closeLine = el('div', 'json-line');
  closeLine.style.paddingLeft = indent + 'px';
  closeLine.appendChild(span('j-bracket', closeBracket));
  if (!isLast) closeLine.appendChild(span('j-comma', ','));
  container.appendChild(closeLine);

  // ── Toggle logic
  function doToggle(collapse) {
    toggle.dataset.collapsed = String(collapse);
    toggle.textContent = collapse ? '▸ ' : '▾ ';
    children.classList.toggle('collapsed', collapse);
    summary.style.display = collapse ? 'inline' : 'none';
    closeLine.style.display = collapse ? 'none' : 'block';
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    doToggle(toggle.dataset.collapsed === 'false');
  });
  summary.addEventListener('click', (e) => {
    e.stopPropagation();
    doToggle(false);
  });
  openLine.addEventListener('click', (e) => {
    if (e.target === openLine) doToggle(toggle.dataset.collapsed === 'false');
  });

  return container;
}

// ── renderJsonFromRaw ────────────────────────────────────────────────────

/**
 * Given a raw log line string, extract JSON blocks and render them as
 * collapsible DOM nodes. Non-JSON prefix/suffix text is shown as plain text.
 *
 * @param {string} rawLine
 * @returns {HTMLElement}
 */
export function renderJsonFromRaw(rawLine) {
  const root = el('div', 'json-root');
  const blocks = extractJsonBlocks(rawLine);

  if (!blocks.length) {
    // No JSON — just show the raw text
    const pre = el('div', 'json-prefix');
    pre.textContent = rawLine;
    root.appendChild(pre);
    return root;
  }

  let cursor = 0;
  for (const blk of blocks) {
    // Prefix text before this block
    if (blk.start > cursor) {
      const prefix = rawLine.slice(cursor, blk.start);
      if (prefix.trim()) {
        const p = el('div', 'json-prefix');
        p.textContent = prefix;
        root.appendChild(p);
      }
    }

    try {
      const parsed = JSON.parse(blk.raw);
      const label = el('span', 'blk-label', Array.isArray(parsed) ? 'array' : 'object');
      root.appendChild(label);
      root.appendChild(renderJsonValue(parsed, 0, true, null));
    } catch (_) {
      // Fallback: show raw
      const p = el('div', 'json-prefix');
      p.textContent = blk.raw;
      root.appendChild(p);
    }

    cursor = blk.end;
  }

  // Suffix after last block
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
 * Traverse all json-toggle elements inside `container` and expand or collapse them.
 *
 * @param {HTMLElement} container
 * @param {boolean} collapsed
 */
export function setAllCollapsed(container, collapsed) {
  const toggles = container.querySelectorAll('.json-toggle[data-collapsed]');
  for (const toggle of toggles) {
    const isCollapsed = toggle.dataset.collapsed === 'true';
    if (isCollapsed !== collapsed) {
      toggle.click();
    }
  }
}

// ── highlightSearch ──────────────────────────────────────────────────────

/**
 * Remove existing <mark> elements from container, then add new ones
 * around all text matching `searchText` (case-insensitive).
 *
 * @param {HTMLElement} container
 * @param {string} searchText
 */
export function highlightSearch(container, searchText) {
  // First, remove all existing marks
  for (const mark of Array.from(container.querySelectorAll('mark'))) {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }

  if (!searchText || !searchText.trim()) return;

  const needle = searchText.toLowerCase();
  highlightTextNodes(container, needle);
}

function highlightTextNodes(node, needle) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent;
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
    for (const child of Array.from(node.childNodes)) {
      highlightTextNodes(child, needle);
    }
  }
}

// ── renderDiff ───────────────────────────────────────────────────────────

/**
 * Render a diff between two log line objects (or JSON strings).
 * `a` = pinned line, `b` = current line.
 *
 * @param {{raw:string}} a - pinned log entry
 * @param {{raw:string}} b - current log entry
 * @returns {HTMLElement}
 */
export function renderDiff(a, b) {
  const root = el('div', 'diff-root');

  const aJson = extractFirstJson(a.raw);
  const bJson = extractFirstJson(b.raw);

  if (!aJson && !bJson) {
    const note = el('div', 'diff-header');
    note.textContent = 'No JSON found in either log line.';
    root.appendChild(note);
    return root;
  }

  if (!aJson) {
    const note = el('div', 'diff-header');
    note.textContent = 'Pinned line has no JSON to compare.';
    root.appendChild(note);
    return root;
  }

  if (!bJson) {
    const note = el('div', 'diff-header');
    note.textContent = 'Current line has no JSON to compare.';
    root.appendChild(note);
    return root;
  }

  const header = el('span', 'diff-header');
  header.textContent = 'Pinned → Current';
  root.appendChild(header);

  diffObjects(root, aJson, bJson, 0);
  return root;
}

function extractFirstJson(raw) {
  const blocks = extractJsonBlocks(raw);
  if (!blocks.length) return null;
  try {
    return JSON.parse(blocks[0].raw);
  } catch (_) {
    return null;
  }
}

function diffObjects(container, a, b, depth) {
  const indent = depth * 14;
  const aIsObj = a && typeof a === 'object' && !Array.isArray(a);
  const bIsObj = b && typeof b === 'object' && !Array.isArray(b);
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);

  if (aIsObj && bIsObj) {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      const hasA = Object.prototype.hasOwnProperty.call(a, key);
      const hasB = Object.prototype.hasOwnProperty.call(b, key);
      if (!hasA) {
        appendDiffLine(container, 'added', key, undefined, b[key], indent);
      } else if (!hasB) {
        appendDiffLine(container, 'removed', key, a[key], undefined, indent);
      } else if (deepEqual(a[key], b[key])) {
        appendDiffLine(container, 'same', key, a[key], b[key], indent);
      } else if (
        a[key] && b[key] &&
        typeof a[key] === 'object' && typeof b[key] === 'object'
      ) {
        // Recurse into nested object
        const row = el('div', 'diff-same');
        row.style.paddingLeft = indent + 'px';
        row.appendChild(span('j-key', JSON.stringify(key) + ':'));
        container.appendChild(row);
        diffObjects(container, a[key], b[key], depth + 1);
      } else {
        appendDiffLine(container, 'changed', key, a[key], b[key], indent);
      }
    }
  } else if (aIsArr && bIsArr) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= a.length) {
        appendDiffLine(container, 'added', i, undefined, b[i], indent);
      } else if (i >= b.length) {
        appendDiffLine(container, 'removed', i, a[i], undefined, indent);
      } else if (deepEqual(a[i], b[i])) {
        appendDiffLine(container, 'same', i, a[i], b[i], indent);
      } else {
        appendDiffLine(container, 'changed', i, a[i], b[i], indent);
      }
    }
  } else {
    // Type changed entirely
    appendDiffLine(container, 'changed', null, a, b, indent);
  }
}

function appendDiffLine(container, type, key, aVal, bVal, indent) {
  const row = el('div', 'diff-' + type);
  row.style.paddingLeft = indent + 'px';

  if (key !== null && key !== undefined) {
    row.appendChild(span('j-key', JSON.stringify(key) + ': '));
  }

  if (type === 'added') {
    row.appendChild(span('j-str', JSON.stringify(bVal)));
    row.appendChild(span('diff-label', ' +added'));
  } else if (type === 'removed') {
    row.appendChild(span('j-str', JSON.stringify(aVal)));
    row.appendChild(span('diff-label', ' -removed'));
  } else if (type === 'changed') {
    row.appendChild(span('diff-old-val', JSON.stringify(aVal)));
    row.appendChild(document.createTextNode('→ '));
    row.appendChild(span('diff-new-val', JSON.stringify(bVal)));
    row.appendChild(span('diff-label', ' ~changed'));
  } else {
    // same
    row.appendChild(span('j-plain', JSON.stringify(aVal)));
  }

  container.appendChild(row);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => deepEqual(a[k], b[k]));
}
