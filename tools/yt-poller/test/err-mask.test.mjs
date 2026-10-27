// Poller log lines must never carry a secret value, including an upstream
// fetch error whose message echoes the key-bearing videos.list URL. poller.mjs
// is not import-safe in a test process, so its log sites are pinned by source
// text; the masking itself is driven for real.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { maskSecrets, describeErr } from '../watchdog.mjs';
import { fetchYtVideoState, fetchYtCounts } from '../yt-counts.mjs';

const FAKE_KEY = 'AIzaFAKEKEY-abc123_XYZ';
const FAKE_INGEST = 'fake-ingest-secret-ABC123';

afterEach(() => { vi.restoreAllMocks(); });

describe('maskSecrets / describeErr', () => {
  it('masks exact values, key= query values and percent-encoded values', () => {
    const out = maskSecrets(`a ${FAKE_KEY} b ?x=1&key=OTHERVAL c ${encodeURIComponent('s e/c')}`, [FAKE_KEY, 's e/c']);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).not.toContain('OTHERVAL');
    expect(out).not.toContain('s%20e%2Fc');
  });
  it('ignores empty / non-string secrets', () => {
    expect(maskSecrets('plain', ['', undefined, null, 5])).toBe('plain');
  });
  it('describeErr handles non-Error throws and never throws', () => {
    expect(describeErr('boom', [])).toBe('boom');
    const nasty = { get message() { throw new Error('x'); } };
    expect(() => describeErr(nasty, [])).not.toThrow();
  });
  it('describeErr includes the cause chain, masked', () => {
    const err = new Error('outer', { cause: new Error(`inner ${FAKE_KEY}`) });
    const out = describeErr(err, [FAKE_KEY]);
    expect(out).toContain('outer');
    expect(out).not.toContain(FAKE_KEY);
  });
});

describe('yt-counts fetch failure log', () => {
  const urlErr = () => new TypeError(`request to https://www.googleapis.com/youtube/v3/videos?part=statistics&id=v1&key=${FAKE_KEY} failed, reason: socket hang up`);
  it('fetchYtVideoState: emitted line holds no key value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await fetchYtVideoState('v1', FAKE_KEY, { fetchImpl: async () => { throw urlErr(); } });
    expect(r.counts).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.flat().join(' ')).not.toContain(FAKE_KEY);
  });
  it('fetchYtCounts: same', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fetchYtCounts('v1', FAKE_KEY, { fetchImpl: async () => { throw urlErr(); } });
    expect(spy.mock.calls.flat().join(' ')).not.toContain(FAKE_KEY);
  });
  it('bare key echoed without key= is masked too', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fetchYtVideoState('v1', FAKE_KEY, { fetchImpl: async () => { throw new Error(`quota for ${FAKE_KEY} exceeded`); } });
    expect(spy.mock.calls.flat().join(' ')).not.toContain(FAKE_KEY);
  });
});

describe('source sweep: no unmasked error text in any poller log path', () => {
  const dir = new URL('..', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('authed-chat-difftest') && f !== 'capture.mjs');
  // A console.* call (or log-line formatter call) that mentions err/message/stack/cause raw.
  const RAW = /\b(?:err|error|e)\??\.(?:message|stack|cause)\b|String\(\s*err\s*\)|\$\{\s*err\s*\}|lastErrorMsg/;
  for (const f of files) {
    it(`${f}: every console.* line that interpolates an error goes through describeErr/maskErr/maskSecrets`, () => {
      const src = readFileSync(new URL(f, dir), 'utf8').split('\n');
      const bad = [];
      src.forEach((line, i) => {
        if (line.trim().startsWith('//')) return;
        if (!/console\.(error|log|warn)\(/.test(line)) return;
        if (RAW.test(line) && !/describeErr|maskErr|maskSecrets|maskedMsg/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
      expect(bad).toEqual([]);
    });
  }
  it('poller.mjs masks with a set that holds YOUTUBE_API_KEY and the ingest secret', () => {
    const src = readFileSync(new URL('poller.mjs', dir), 'utf8');
    expect(src).toMatch(/const LOG_SECRETS = \[MULTICHAT_INGEST_SECRET, YOUTUBE_API_KEY\]\.filter\(Boolean\);/);
    expect(src).toContain('makeGuardedTick(heartbeatTick, console.log, LOG_SECRETS');
  });
});
