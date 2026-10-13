// Every rediscovery probe that yields no videoId names its reason
// (2026-10-12): probeCurrentLive resolves { videoId, reason, cleanupError,
// detail? } and poller.mjs spreads the null reason into every yt_rediscovery
// line that can carry a null probedVideoId. probeCurrentLiveId stays the
// id-only back-compat wrapper.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { probeCurrentLive, probeCurrentLiveId, formatRediscoveryLog } from '../rediscovery.mjs';

describe('formatRediscoveryLog passes reason fields through, JSON-encoded', () => {
  it('reason / detail / cleanupError survive, CR/LF in detail are escaped', () => {
    const line = formatRediscoveryLog('not_live', { changed: false, probedVideoId: null, reason: 'error_event', detail: 'a\nb\r"c"', cleanupError: 'x' });
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(JSON.parse(line)).toEqual({ ev: 'yt_rediscovery', liveness: 'not_live', changed: false, probedVideoId: null, reason: 'error_event', detail: 'a\nb\r"c"', cleanupError: 'x' });
    // ev and liveness come first and are the formatter's, never a caller's
    expect(line.startsWith('{"ev":"yt_rediscovery","liveness":"not_live",')).toBe(true);
  });
});

function fakeLiveChat({ onStart } = {}) {
  return class extends EventEmitter {
    constructor() { super(); this.stopped = 0; }
    async start() { if (onStart) return onStart(this); }
    stop() { this.stopped++; }
  };
}

describe('probeCurrentLive: reasons', () => {
  it('success: videoId set, reason null, no cleanupError', async () => {
    const C = fakeLiveChat({ onStart: (p) => { p.emit('start', 'abc123'); } });
    expect(await probeCurrentLive(C, 'ch')).toEqual({ videoId: 'abc123', reason: null, cleanupError: null });
  });

  it("'error' event -> error_event with the library's message as detail", async () => {
    const C = fakeLiveChat({ onStart: (p) => { p.emit('error', new Error('Live Stream was not found')); } });
    const r = await probeCurrentLive(C, 'ch');
    expect(r.videoId).toBeNull();
    expect(r.reason).toBe('error_event');
    expect(r.detail).toBe('Live Stream was not found');
  });

  it('start() rejection -> start_rejected with detail', async () => {
    const C = fakeLiveChat({ onStart: () => { throw new Error('boom'); } });
    const r = await probeCurrentLive(C, 'ch');
    expect(r).toMatchObject({ videoId: null, reason: 'start_rejected', detail: 'boom' });
  });

  it('timeout -> timeout, no detail', async () => {
    const C = fakeLiveChat();
    const r = await probeCurrentLive(C, 'ch', { timeoutMs: 5 });
    expect(r).toEqual({ videoId: null, reason: 'timeout', cleanupError: null });
  });

  it("'start' with an empty id -> empty_live_id", async () => {
    const C = fakeLiveChat({ onStart: (p) => { p.emit('start', ''); } });
    expect((await probeCurrentLive(C, 'ch')).reason).toBe('empty_live_id');
  });

  it('a throwing stop() is swallowed and surfaces as cleanupError, result unchanged', async () => {
    class C extends EventEmitter {
      async start() { this.emit('start', 'abc123'); }
      stop() { throw new Error('already stopped'); }
    }
    const r = await probeCurrentLive(C, 'ch');
    expect(r.videoId).toBe('abc123');
    expect(r.cleanupError).toBe('already stopped');
  });

  it('detail is capped at 160 chars and absent when the error has no message', async () => {
    const long = 'x'.repeat(500);
    const C = fakeLiveChat({ onStart: (p) => { p.emit('error', new Error(long)); } });
    expect((await probeCurrentLive(C, 'ch')).detail).toHaveLength(160);
    const C2 = fakeLiveChat({ onStart: (p) => { p.emit('error', undefined); } });
    const r2 = await probeCurrentLive(C2, 'ch');
    expect(r2.reason).toBe('error_event');
    expect(r2).not.toHaveProperty('detail');
  });

  it('probeCurrentLiveId wrapper still resolves the bare id / null', async () => {
    const ok = fakeLiveChat({ onStart: (p) => { p.emit('start', 'abc123'); } });
    const bad = fakeLiveChat({ onStart: (p) => { p.emit('error', new Error('nope')); } });
    await expect(probeCurrentLiveId(ok, 'ch')).resolves.toBe('abc123');
    await expect(probeCurrentLiveId(bad, 'ch')).resolves.toBeNull();
  });
});

describe('poller.mjs wiring (source text; poller.mjs is not import-safe)', () => {
  const src = readFileSync(new URL('../poller.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function runRediscoveryProbe'), src.indexOf('async function runRediscoveryProbe') + 3000);

  it('uses probeCurrentLive and spreads the reason into every null-capable log line', () => {
    expect(src).toMatch(/import \{[^}]*probeCurrentLive\b[^}]*\} from '\.\/rediscovery\.mjs'/);
    expect(fn).toContain('const probe = await probeCurrentLive(LiveChat, YT_CHANNEL_ID);');
    expect(fn).toContain('reason: probe.reason');
    expect(fn).toContain('cleanupError: probe.cleanupError');
    // the three lines that can carry probedVideoId: null all carry ...why
    expect(fn.match(/probedVideoId: probedVideoId \|\| null, \.\.\.why/g)).toHaveLength(3);
  });
});
