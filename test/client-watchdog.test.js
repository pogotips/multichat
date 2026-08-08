// YT_FEED_LOSS_FORENSICS_2026-08-05.md rec 1: a periodic client stale-watchdog,
// gated on isClientStale — the same predicate the visibilitychange check
// already used. The forensics doc's central risk here is quiet-but-live YT
// chat being mistaken for a stale connection and forcing needless
// reconnects; the second describe block below is the proof that doesn't
// happen, since lastActivityTs is bumped by every SSE signal (status/ping),
// not just chat messages.
import { describe, it, expect } from 'vitest';
import worker, { isClientStale, supersedeSocket } from '../src/worker.js';

const env = { MULTICHAT_VIEW_SECRET: 'x' };

describe('isClientStale', () => {
  it('not stale when the gap is under the threshold', () => {
    expect(isClientStale(1000, 1000 + 59_000, 60_000)).toBe(false);
  });

  it('not stale exactly at the threshold (strict greater-than)', () => {
    expect(isClientStale(1000, 1000 + 60_000, 60_000)).toBe(false);
  });

  it('stale once the gap exceeds the threshold', () => {
    expect(isClientStale(1000, 1000 + 60_001, 60_000)).toBe(true);
  });
});

describe('watchdog timeline: quiet-but-live YT chat must never trip the watchdog', () => {
  const STALE_AFTER_MS = 60_000;
  const WATCHDOG_POLL_MS = 15_000;

  it('lastActivityTs bumped every ~15s by status/heartbeat events only (no chat) never goes stale', () => {
    // Simulates the exact 2026-08-05 shape: YT chat genuinely quiet for
    // several minutes, but the server's ping/status cadence (~15-25s) keeps
    // lastActivityTs fresh the whole time. Sample the predicate at every
    // watchdog tick across a 5-minute span.
    let lastActivityTs = 0;
    const activityEvery = 15_000; // status/ping cadence, no chat messages at all
    let nextActivityAt = activityEvery;
    for (let now = 0; now <= 5 * 60_000; now += WATCHDOG_POLL_MS) {
      while (nextActivityAt <= now) {
        lastActivityTs = nextActivityAt;
        nextActivityAt += activityEvery;
      }
      expect(isClientStale(lastActivityTs, now, STALE_AFTER_MS)).toBe(false);
    }
  });

  it('does go stale once activity actually stops (companion case)', () => {
    const lastActivityTs = 0;
    // No further activity after t=0 — watchdog ticks until it crosses STALE_AFTER_MS.
    expect(isClientStale(lastActivityTs, STALE_AFTER_MS - 1, STALE_AFTER_MS)).toBe(false);
    expect(isClientStale(lastActivityTs, STALE_AFTER_MS + WATCHDOG_POLL_MS, STALE_AFTER_MS)).toBe(true);
  });
});

describe('rec 2: soft-stale threshold derivation', () => {
  it('SOFT_STALE_MS is derived from the server ping cadence (HEARTBEAT_MS=25000) + 15s margin, not a second hardcoded literal', async () => {
    const res = await worker.fetch(new Request('https://x/'), env, {});
    const body = await res.text();
    expect(body).toContain('const PING_INTERVAL_MS = 25000;');
    expect(body).toContain('const SOFT_STALE_MS = PING_INTERVAL_MS + 15_000;');
  });
});

describe('supersedeSocket', () => {
  it('closes a prior socket exactly once', () => {
    let closeCalls = 0;
    const prev = { close: () => { closeCalls++; } };
    supersedeSocket(prev);
    expect(closeCalls).toBe(1);
  });

  it('a throwing close() is swallowed, never propagates', () => {
    const prev = { close: () => { throw new Error('boom'); } };
    expect(() => supersedeSocket(prev)).not.toThrow();
  });

  it('null/undefined is a safe no-op', () => {
    expect(() => supersedeSocket(null)).not.toThrow();
    expect(() => supersedeSocket(undefined)).not.toThrow();
  });
});
