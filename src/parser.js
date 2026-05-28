// ── Log line parser ──────────────────────────────────────────────────────

const LINE_RE = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\s+(INFO|ERROR|DEBUG|WARN)\s+(#[a-f0-9-]+):\s+(?:(HTTP|SLAVE|BUS|FRONT|MASTER)\s+)?(?:(>>>|<--|<<|>>|>|<)\s+)?(.*)$/;

/**
 * Parse a full log text into an array of log entry objects.
 * Multi-line log entries (continuation lines) are appended to the previous entry.
 *
 * @param {string} text
 * @returns {Array<{time:string, level:string, trace:string, comp:string, dir:string, body:string, raw:string, idx:number}>}
 */
export function parseLines(text) {
  const result = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(LINE_RE);
    if (m) {
      result.push({
        time:  m[1],
        level: m[2],
        trace: m[3],
        comp:  m[4] || 'OTHER',
        dir:   m[5] || '',
        body:  m[6],
        raw:   line,
        idx:   result.length,
      });
    } else if (result.length) {
      result[result.length - 1].body += '\n' + line;
      result[result.length - 1].raw  += '\n' + line;
    } else {
      result.push({
        time:  '',
        level: 'INFO',
        trace: '',
        comp:  'OTHER',
        dir:   '',
        body:  line,
        raw:   line,
        idx:   result.length,
      });
    }
  }
  return result;
}

/**
 * Extract JSON object/array blocks from a string.
 * Returns an array of { raw, start, end } objects.
 *
 * @param {string} str
 * @returns {Array<{raw:string, start:number, end:number}>}
 */
export function extractJsonBlocks(str) {
  const blocks = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '{' || str[i] === '[') {
      const start = i;
      const stack = [];
      let inStr = false;
      let slash = false;
      for (; i < str.length; i++) {
        const c = str[i];
        if (slash) { slash = false; continue; }
        if (c === '\\' && inStr) { slash = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') {
          stack.push(c);
        } else if (c === '}' || c === ']') {
          stack.pop();
          if (!stack.length) {
            blocks.push({ raw: str.slice(start, i + 1), start, end: i + 1 });
            i++;
            break;
          }
        }
      }
    } else {
      i++;
    }
  }
  return blocks;
}
