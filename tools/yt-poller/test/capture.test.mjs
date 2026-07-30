import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpCount, appendCapture } from '../capture.mjs';

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
