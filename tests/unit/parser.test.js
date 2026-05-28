import { describe, it, expect } from 'vitest';
import { parseLines, extractJsonBlocks } from '../../src/parser.js';

// ─── parseLines ────────────────────────────────────────────────────────────

describe('parseLines', () => {
  it('parses a standard INFO line', () => {
    const line = '2024/01/15 14:23:45 INFO #abc12345-0001: HTTP >>> {"action":"login"}';
    const [entry] = parseLines(line);
    expect(entry.time).toBe('2024/01/15 14:23:45');
    expect(entry.level).toBe('INFO');
    expect(entry.trace).toBe('#abc12345-0001');
    expect(entry.comp).toBe('HTTP');
    expect(entry.dir).toBe('>>>');
    expect(entry.body).toBe('{"action":"login"}');
    expect(entry.idx).toBe(0);
  });

  it('parses ERROR level', () => {
    const [entry] = parseLines('2024/01/15 14:23:48 ERROR #def67890: HTTP <-- {"status":404}');
    expect(entry.level).toBe('ERROR');
    expect(entry.dir).toBe('<--');
  });

  it('parses WARN level', () => {
    const [entry] = parseLines('2024/01/15 14:23:48 WARN #def67890: BUS timeout');
    expect(entry.level).toBe('WARN');
  });

  it('parses DEBUG level', () => {
    const [entry] = parseLines('2024/01/15 14:23:48 DEBUG #def67890: FRONT render');
    expect(entry.level).toBe('DEBUG');
  });

  it('assigns OTHER comp when comp is missing', () => {
    const [entry] = parseLines('2024/01/15 14:23:52 INFO #aaa11111: {"action":"health"}');
    expect(entry.comp).toBe('OTHER');
    expect(entry.dir).toBe('');
  });

  it('parses all comp types: HTTP, SLAVE, BUS, FRONT, MASTER', () => {
    for (const comp of ['HTTP', 'SLAVE', 'BUS', 'FRONT', 'MASTER']) {
      const [entry] = parseLines(`2024/01/15 14:23:45 INFO #abc-0001: ${comp} msg`);
      expect(entry.comp).toBe(comp);
    }
  });

  it('assigns sequential idx values', () => {
    const text = [
      '2024/01/15 14:23:45 INFO #a-0001: HTTP line1',
      '2024/01/15 14:23:46 INFO #a-0002: HTTP line2',
      '2024/01/15 14:23:47 INFO #a-0003: HTTP line3',
    ].join('\n');
    const lines = parseLines(text);
    expect(lines.map(l => l.idx)).toEqual([0, 1, 2]);
  });

  it('raw field preserves the original line', () => {
    const original = '2024/01/15 14:23:45 INFO #abc-0001: HTTP >>> {"action":"test"}';
    const [entry] = parseLines(original);
    expect(entry.raw).toBe(original);
  });

  it('skips empty lines', () => {
    const text = '\n  \n2024/01/15 14:23:45 INFO #a-0001: HTTP msg\n\n';
    const lines = parseLines(text);
    expect(lines).toHaveLength(1);
  });

  it('appends continuation lines to previous entry body', () => {
    const text = [
      '2024/01/15 14:23:45 INFO #abc-0001: HTTP >>> {"action":"test"}',
      '  at some.stack.trace',
      '  at another.trace',
    ].join('\n');
    const lines = parseLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0].body).toContain('stack.trace');
    expect(lines[0].body).toContain('another.trace');
  });

  it('continuation also appends to raw', () => {
    const text = [
      '2024/01/15 14:23:45 INFO #abc-0001: HTTP >>> test',
      '  continuation',
    ].join('\n');
    const [entry] = parseLines(text);
    expect(entry.raw).toContain('continuation');
  });

  it('handles unmatched lines as OTHER/INFO fallback', () => {
    const [entry] = parseLines('some random log text without format');
    expect(entry.level).toBe('INFO');
    expect(entry.comp).toBe('OTHER');
    expect(entry.body).toBe('some random log text without format');
    expect(entry.time).toBe('');
    expect(entry.trace).toBe('');
  });

  it('parses multiple lines correctly', () => {
    const text = [
      '2024/01/15 14:23:45 INFO #a-0001: HTTP >>> {"a":1}',
      '2024/01/15 14:23:46 ERROR #a-0002: BUS {"error":"oops"}',
      '2024/01/15 14:23:47 WARN #a-0003: SLAVE timeout',
    ].join('\n');
    const lines = parseLines(text);
    expect(lines).toHaveLength(3);
    expect(lines.map(l => l.level)).toEqual(['INFO', 'ERROR', 'WARN']);
    expect(lines.map(l => l.comp)).toEqual(['HTTP', 'BUS', 'SLAVE']);
  });

  it('parses direction arrows: >>>, <--, <<, >>, >', () => {
    for (const dir of ['>>>', '<--', '<<', '>>', '>']) {
      const [entry] = parseLines(`2024/01/15 14:23:45 INFO #a-0001: HTTP ${dir} msg`);
      expect(entry.dir).toBe(dir);
    }
  });

  it('returns empty array for empty string', () => {
    expect(parseLines('')).toEqual([]);
    expect(parseLines('   \n   ')).toEqual([]);
  });
});

// ─── extractJsonBlocks ─────────────────────────────────────────────────────

describe('extractJsonBlocks', () => {
  it('extracts a simple object', () => {
    const [block] = extractJsonBlocks('prefix {"key":"value"} suffix');
    expect(block.raw).toBe('{"key":"value"}');
  });

  it('extracts an array', () => {
    const [block] = extractJsonBlocks('[1, 2, 3]');
    expect(block.raw).toBe('[1, 2, 3]');
  });

  it('extracts multiple blocks', () => {
    const blocks = extractJsonBlocks('{"a":1} text {"b":2}');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].raw).toBe('{"a":1}');
    expect(blocks[1].raw).toBe('{"b":2}');
  });

  it('handles nested objects', () => {
    const [block] = extractJsonBlocks('{"outer":{"inner":"val"}}');
    expect(block.raw).toBe('{"outer":{"inner":"val"}}');
  });

  it('handles strings with braces inside (no false split)', () => {
    const [block] = extractJsonBlocks('{"key":"value with {braces}"}');
    expect(block.raw).toBe('{"key":"value with {braces}"}');
  });

  it('handles escaped quotes in strings', () => {
    const [block] = extractJsonBlocks('{"key":"he said \\"hello\\""}');
    expect(block.raw).toBe('{"key":"he said \\"hello\\""}');
  });

  it('records start/end positions', () => {
    const [block] = extractJsonBlocks('xx {"k":"v"} yy');
    expect(block.start).toBe(3);
    expect(block.end).toBe(12);
  });

  it('returns empty array for text without JSON', () => {
    expect(extractJsonBlocks('just plain text')).toHaveLength(0);
    expect(extractJsonBlocks('')).toHaveLength(0);
  });

  it('handles array of objects', () => {
    const [block] = extractJsonBlocks('[{"a":1},{"b":2}]');
    expect(block.raw).toBe('[{"a":1},{"b":2}]');
  });
});
