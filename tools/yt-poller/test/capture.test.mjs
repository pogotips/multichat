import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpCount, appendCapture, summarizeUnknownRenderers } from '../capture.mjs';

describe('bumpCount', () => {
  it('starts a type at 1', () => {
    expect(bumpCount({}, 'liveChatPaidJewelRenderer')).toEqual({ liveChatPaidJewelRenderer: 1 });
  });

  it('increments an existing type', () => {
    expect(bumpCount({ foo: 2 }, 'foo')).toEqual({ foo: 3 });
  });

  it('leaves other types untouched', () => {
    expect(bumpCount({ foo: 1, bar: 5 }, 'foo')).toEqual({ foo: 2, bar: 5 });
  });
});

describe('appendCapture', () => {
  let dir;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates the file (and parent dir) and appends one JSON line', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
    const file = path.join(dir, 'nested', 'unknown-renderers.jsonl');
    appendCapture(file, { hello: 'world' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"hello":"world"}\n');
  });

  it('appends subsequent calls rather than overwriting', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
    const file = path.join(dir, 'log.jsonl');
    appendCapture(file, { n: 1 });
    appendCapture(file, { n: 2 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n');
  });

  it('rotates to .1 once the next line would exceed maxBytes', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
    const file = path.join(dir, 'log.jsonl');
    appendCapture(file, { n: 1 }, 20); // '{"n":1}\n' is 8 bytes, fits under 20
    appendCapture(file, { n: 2 }, 20); // 8+8=16, still fits
    appendCapture(file, { n: 3 }, 20); // 16+8=24 > 20 -> rotate first
    expect(fs.readFileSync(file + '.1', 'utf8')).toBe('{"n":1}\n{"n":2}\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"n":3}\n');
  });

  it('a failing rotate rename still appends the line and logs one capture_rotate_failed', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
    const file = path.join(dir, 'log.jsonl');
    appendCapture(file, { n: 1 }, 10);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { const e = new Error('nope'); e.code = 'EACCES'; throw e; });
    try {
      appendCapture(file, { n: 2 }, 10); // would rotate; rename throws
      expect(fs.readFileSync(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n');
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0][0])).toBe('{"ev":"capture_rotate_failed","code":"EACCES"}');
    } finally {
      renameSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('a second rotation overwrites the previous .1', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
    const file = path.join(dir, 'log.jsonl');
    appendCapture(file, { n: 1 }, 10);
    appendCapture(file, { n: 2 }, 10); // rotate: .1 = {n:1}, fresh file = {n:2}
    appendCapture(file, { n: 3 }, 10); // rotate again: .1 = {n:2}, fresh file = {n:3}
    expect(fs.readFileSync(file + '.1', 'utf8')).toBe('{"n":2}\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"n":3}\n');
  });
});

describe('summarizeUnknownRenderers', () => {
  it('caps at 10 entries, sorted by count desc then name', () => {
    const counts = {};
    for (let i = 0; i < 15; i++) counts[`r${String(i).padStart(2, '0')}`] = i < 3 ? 100 : i;
    const out = summarizeUnknownRenderers(counts);
    const keys = Object.keys(out);
    expect(keys).toHaveLength(10);
    expect(keys.slice(0, 3)).toEqual(['r00', 'r01', 'r02']);
    expect(Object.values(out)).toEqual([100, 100, 100, 14, 13, 12, 11, 10, 9, 8]);
  });

  it('breaks ties by name and honors a custom max', () => {
    expect(Object.keys(summarizeUnknownRenderers({ b: 1, a: 1, c: 2 }, 2))).toEqual(['c', 'a']);
  });

  it('handles empty/missing input and does not mutate', () => {
    expect(summarizeUnknownRenderers({})).toEqual({});
    expect(summarizeUnknownRenderers(undefined)).toEqual({});
    const c = { x: 1 };
    summarizeUnknownRenderers(c);
    expect(c).toEqual({ x: 1 });
  });
});
