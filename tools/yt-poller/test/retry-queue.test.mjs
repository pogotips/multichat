import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  enqueueRetry, drainBatch, isRetryable, RETRY_QUEUE_MAX, SEND_CONCURRENCY, nextAttempt,
  formatIngestFailureLog, formatIngestErrorLog, noteSendStatus, isPayloadRejection,
} from '../retry-queue.mjs';

describe('nextAttempt', () => {
  it('starts at 1 and increments per call for the same message identity', () => {
    const msg = { user: 'Alice', text: 'hi' };
    expect(nextAttempt(msg)).toBe(1);
    expect(nextAttempt(msg)).toBe(2);
    expect(nextAttempt(msg)).toBe(3);
  });

  it('tracks each message object independently — one message\'s retries never inflate another\'s count', () => {
    const msgA = { user: 'Alice', text: 'hi' };
    const msgB = { user: 'Bob', text: 'yo' };
    expect(nextAttempt(msgA)).toBe(1);
    expect(nextAttempt(msgA)).toBe(2);
    expect(nextAttempt(msgB)).toBe(1);
  });

  it('two distinct objects with identical content are still counted separately (identity, not equality)', () => {
    const first = { user: 'Alice', text: 'hi' };
    const second = { user: 'Alice', text: 'hi' };
    expect(nextAttempt(first)).toBe(1);
    expect(nextAttempt(second)).toBe(1);
    expect(nextAttempt(first)).toBe(2);
  });

  it('a non-object msg (e.g. a bare string test double) always reads as attempt 1, never throws', () => {
    expect(nextAttempt('msgA')).toBe(1);
    expect(nextAttempt('msgA')).toBe(1);
    expect(nextAttempt(null)).toBe(1);
    expect(nextAttempt(undefined)).toBe(1);
  });
});

// Internal ship report (2026-08-09): "attempt=N retry logging never observed"
// — nextAttempt (above) was already wired into both of sendOnce's failure
// log lines in poller.mjs, but nothing pinned the log string's actual shape,
// so a silent regression there would only ever have surfaced on a live
// stream. Pulling the two formatters out as pure functions makes the
// attempt=N field's presence provable without one.
describe('formatIngestFailureLog', () => {
  it('includes status, body text, and attempt=N', () => {
    expect(formatIngestFailureLog(500, 'server error', 1)).toBe('ingest failed: 500 server error attempt=1');
  });

  it('reflects a later attempt number on a retried send', () => {
    const msg = { user: 'Alice', text: 'hi' };
    nextAttempt(msg); // attempt 1, consumed
    const attempt = nextAttempt(msg); // attempt 2 — mirrors a real retry
    expect(formatIngestFailureLog(429, 'rate limited', attempt)).toBe('ingest failed: 429 rate limited attempt=2');
  });
});

describe('formatIngestErrorLog', () => {
  it('includes the error message and attempt=N', () => {
    expect(formatIngestErrorLog('fetch failed', 1)).toBe('ingest error: fetch failed attempt=1');
  });

  it('reflects a later attempt number on a retried send', () => {
    const msg = { user: 'Bob', text: 'yo' };
    nextAttempt(msg); // attempt 1, consumed
    const attempt = nextAttempt(msg); // attempt 2
    expect(formatIngestErrorLog('timeout', attempt)).toBe('ingest error: timeout attempt=2');
  });
});

describe('isRetryable', () => {
  it('excludes heartbeats', () => {
    expect(isRetryable({ type: 'heartbeat' })).toBe(false);
  });
  it('includes chat messages', () => {
    expect(isRetryable({ user: 'Alice', text: 'hi' })).toBe(true);
  });
  it('excludes null/undefined', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('enqueueRetry', () => {
  it('appends an item', () => {
    const queue = [];
    enqueueRetry(queue, 'a', 3);
    expect(queue).toEqual(['a']);
  });

  it('drops the oldest once over maxSize', () => {
    const queue = ['a', 'b', 'c'];
    enqueueRetry(queue, 'd', 3);
    expect(queue).toEqual(['b', 'c', 'd']);
  });

  it('defaults to RETRY_QUEUE_MAX', () => {
    const queue = Array.from({ length: RETRY_QUEUE_MAX }, (_, i) => i);
    enqueueRetry(queue, 'overflow');
    expect(queue.length).toBe(RETRY_QUEUE_MAX);
    expect(queue.at(-1)).toBe('overflow');
    expect(queue[0]).toBe(1); // oldest (0) dropped
  });
});

describe('drainBatch', () => {
  it('sends up to `concurrency` items and empties the queue on all-success', async () => {
    const queue = ['a', 'b', 'c'];
    const sent = [];
    const result = await drainBatch(queue, async (item) => {
      sent.push(item);
      return true;
    }, 4);
    expect(sent.sort()).toEqual(['a', 'b', 'c']);
    expect(queue).toEqual([]);
    expect(result).toEqual({ attempted: 3, sent: 3, dropped: 0 });
  });

  it('only claims `concurrency` items when the queue is larger', async () => {
    const queue = ['a', 'b', 'c', 'd', 'e'];
    const result = await drainBatch(queue, async () => true, 2);
    expect(result.attempted).toBe(2);
    expect(queue).toEqual(['c', 'd', 'e']); // untouched items stay queued, in order
  });

  it('runs the batch concurrently, not sequentially', async () => {
    const queue = ['a', 'b', 'c', 'd'];
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    // Peak-in-flight counter, not a real-clock bound — deterministic and
    // immune to CI scheduling jitter, but still fails if dispatch is
    // serialized (peak would drop to 1).
    let inFlight = 0;
    let peakInFlight = 0;
    await drainBatch(queue, async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await delay(30);
      inFlight--;
      return true;
    }, 4);
    expect(peakInFlight).toBe(4);
  });

  it('requeues failures at the front, preserving their relative order', async () => {
    const queue = ['a', 'b', 'c'];
    const result = await drainBatch(queue, async (item) => item !== 'a' && item !== 'c', 4);
    expect(result).toEqual({ attempted: 3, sent: 1, dropped: 0 });
    expect(queue).toEqual(['a', 'c']); // failures back in original relative order
  });

  it('newly-claimed batch never includes items pushed to the queue mid-flight', async () => {
    const queue = ['a', 'b'];
    const result = await drainBatch(queue, async (item) => {
      if (item === 'a') queue.push('injected-during-flight');
      return true;
    }, 4);
    expect(result.attempted).toBe(2); // only the 2 items present when drainBatch started
    expect(queue).toEqual(['injected-during-flight']);
  });

  it('no-ops on an empty queue', async () => {
    const queue = [];
    const result = await drainBatch(queue, async () => true, 4);
    expect(result).toEqual({ attempted: 0, sent: 0, dropped: 0 });
  });

  it('defaults concurrency to SEND_CONCURRENCY', async () => {
    const queue = Array.from({ length: SEND_CONCURRENCY + 2 }, (_, i) => i);
    const result = await drainBatch(queue, async () => true);
    expect(result.attempted).toBe(SEND_CONCURRENCY);
  });
});

// Poison-message handling: sendOnce (poller.mjs) records the HTTP status of a
// failed send via noteSendStatus; drainBatch drops an item whose status is a
// payload rejection (400/413 — decided by the body alone, so a retry can never
// change the answer) and keeps retrying everything else. Concurrency 1 here
// makes the head-of-line block observable: a poisoned head item that is put
// back every round starves everything queued behind it.
describe('drainBatch poison handling', () => {
  afterEach(() => vi.restoreAllMocks());

  // Mirrors sendOnce: record the status for the message, return falsy.
  const failWith = (msg, status) => {
    noteSendStatus(msg, status);
    return false;
  };

  it('drops a payload-rejected head item after one attempt; the item behind it delivers in the same drain', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const poison = { type: 'bogus_type', ytId: 'yt-poison' };
    const good = { user: 'Alice', text: 'hi', ytId: 'yt-good' };
    const queue = [poison, good];
    const delivered = [];
    const attempts = new Map();
    const sendFn = async (m) => {
      attempts.set(m, (attempts.get(m) || 0) + 1);
      if (m === poison) return failWith(m, 400);
      delivered.push(m);
      return true;
    };
    // Same loop shape as poller.mjs drainLoop, bounded so unfixed code can't hang.
    for (let i = 0; i < 3 && queue.length > 0; i++) await drainBatch(queue, sendFn, 1);
    expect(delivered).toEqual([good]);
    expect(queue).toEqual([]);
    expect(attempts.get(poison)).toBe(1);
    const lines = log.mock.calls.map((c) => JSON.parse(c[0])).filter((l) => l.ev === 'ingest_dropped');
    expect(lines).toEqual([{ ev: 'ingest_dropped', status: 400, type: 'bogus_type', id: 'yt-poison' }]);
  });

  it('drops a 413 too, and the log line carries no body, url or headers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const msg = { user: 'Bob', text: 'SECRET-BODY-TEXT', authorId: 'author-1' };
    const queue = [msg];
    await drainBatch(queue, async (m) => failWith(m, 413), 1);
    expect(queue).toEqual([]);
    const out = log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('"status":413');
    expect(out).toContain('author-1');
    expect(out).not.toContain('SECRET-BODY-TEXT');
  });

  it.each([401, 403, 404, 408, 429, 500, 502, 503])('%i keeps retrying — requeued at the front, never dropped', async (status) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const msg = { user: 'Alice', text: 'hi' };
    const queue = [msg];
    const result = await drainBatch(queue, async (m) => failWith(m, status), 1);
    expect(result).toEqual({ attempted: 1, sent: 0, dropped: 0 });
    expect(queue).toEqual([msg]);
    expect(log).not.toHaveBeenCalled();
  });

  it('reports drops separately from sent, so a drainLoop backoff check of sent + dropped < attempted ignores them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = { type: 'bogus', ytId: 'a' };
    const b = { type: 'bogus', ytId: 'b' };
    const c = { user: 'Alice', text: 'hi' };
    const queue = [a, b, c];
    const result = await drainBatch(queue, async (m) => (m === c ? true : failWith(m, 400)), 4);
    expect(result).toEqual({ attempted: 3, sent: 1, dropped: 2 });
    expect(result.sent + result.dropped < result.attempted).toBe(false);
    const transient = await drainBatch([{ user: 'Bob', text: 'x' }], async (m) => failWith(m, 503), 4);
    expect(transient.sent + transient.dropped < transient.attempted).toBe(true);
  });

  it('a network error (no status recorded) keeps retrying', async () => {
    const msg = { user: 'Alice', text: 'hi' };
    const queue = [msg];
    await drainBatch(queue, async () => false, 1);
    expect(queue).toEqual([msg]);
  });

  it('sendOnce clears the recorded status on a network error, so an earlier status never lingers', async () => {
    const msg = { user: 'Alice', text: 'hi' };
    const queue = [msg];
    await drainBatch(queue, async (m) => failWith(m, 503), 1); // attempt 1: 503 recorded
    await drainBatch(queue, async (m) => { noteSendStatus(m, undefined); return false; }, 1); // attempt 2: network error
    expect(queue).toEqual([msg]);
    await drainBatch(queue, async (m) => { noteSendStatus(m, undefined); return true; }, 1);
    expect(queue).toEqual([]);
  });
});

describe('isPayloadRejection', () => {
  it('is true only for 400 and 413', () => {
    expect(isPayloadRejection(400)).toBe(true);
    expect(isPayloadRejection(413)).toBe(true);
    for (const s of [200, 401, 403, 404, 408, 429, 500, 503, undefined, null]) {
      expect(isPayloadRejection(s)).toBe(false);
    }
  });
});

// sendOnce lives in poller.mjs, which is not import-safe in a test process, so
// pin the wiring by source: both failure paths must record the status that
// drainBatch reads, or poison items silently go back to being retried forever.
describe('poller.mjs wiring of the poison-drop status', () => {
  const src = readFileSync(new URL('../poller.mjs', import.meta.url), 'utf8');
  const sendOnce = src.slice(src.indexOf('async function sendOnce'), src.indexOf('async function drainLoop'));
  it('sendOnce records the HTTP status on a non-ok response and clears it on a network error', () => {
    expect(sendOnce).toContain('noteSendStatus(msg, res.ok ? undefined : res.status);');
    expect(sendOnce).toMatch(/catch \(err\) \{[\s\S]*noteSendStatus\(msg, undefined\);/);
  });
  it('drainLoop backs off only for failures that are neither sent nor dropped', () => {
    expect(src).toContain('sent + dropped < attempted');
  });
});

describe('enqueueRetry overflow eviction', () => {
  it('evicts the oldest N past the cap, calls onEvict per item, keeps the newest maxSize', () => {
    const q = [];
    const evicted = [];
    for (let i = 1; i <= 5; i++) enqueueRetry(q, { i }, 3, (x) => evicted.push(x));
    expect(evicted).toEqual([{ i: 1 }, { i: 2 }]);
    expect(q).toEqual([{ i: 3 }, { i: 4 }, { i: 5 }]);
  });

  it('without onEvict behaves exactly as before and returns the queue', () => {
    const q = [];
    let ret;
    for (let i = 1; i <= 5; i++) ret = enqueueRetry(q, i, 3);
    expect(ret).toBe(q);
    expect(q).toEqual([3, 4, 5]);
    const q2 = [];
    for (let i = 1; i <= RETRY_QUEUE_MAX + 2; i++) enqueueRetry(q2, i);
    expect(q2).toHaveLength(RETRY_QUEUE_MAX);
    expect(q2[0]).toBe(3);
  });

  it('does not call onEvict when under the cap', () => {
    const onEvict = vi.fn();
    enqueueRetry([], 'a', 3, onEvict);
    expect(onEvict).not.toHaveBeenCalled();
  });
});

// drainBatch's re-queue unshifts failures onto the FRONT; anything enqueued
// while the batch was in flight already sits behind them, so the queue can
// exceed its bound right there. It must trim with enqueueRetry's policy
// (oldest-first from the front, each reported to onEvict), never grow past max.
describe('drainBatch re-queue respects the queue bound', () => {
  it('evicts the oldest failed items first when in-flight enqueues filled the queue', async () => {
    const queue = ['a', 'b', 'c'];
    const evicted = [];
    const result = await drainBatch(queue, async (item) => {
      if (item === 'a') { queue.push('d', 'e'); } // lands behind the in-flight batch
      return false; // a and b both fail transiently
    }, 2, 3, (item) => evicted.push(item));
    expect(queue.length).toBeLessThanOrEqual(3);
    expect(queue).toEqual(['c', 'd', 'e']);
    expect(evicted).toEqual(['a', 'b']);
    // evicted failures are still failures for the caller's backoff: attempted, not sent, not payload-dropped
    expect(result).toEqual({ attempted: 2, sent: 0, dropped: 0 });
  });

  it('uses the same eviction order and count as enqueueRetry', async () => {
    const viaEnqueue = ['c', 'd', 'e'];
    const enqueueEvicted = [];
    enqueueRetry(viaEnqueue, 'f', 3, (x) => enqueueEvicted.push(x));
    const viaDrain = ['b', 'c', 'd', 'e']; // b is claimed, fails, comes back at the front: 4 items, max 3
    const drainEvicted = [];
    await drainBatch(viaDrain, async () => false, 1, 3, (x) => drainEvicted.push(x));
    expect(viaEnqueue).toEqual(['d', 'e', 'f']);
    expect(enqueueEvicted).toEqual(['c']);
    expect(viaDrain).toEqual(['c', 'd', 'e']);
    expect(drainEvicted).toEqual(['b']);
  });

  it('defaults the bound to RETRY_QUEUE_MAX', async () => {
    const queue = Array.from({ length: RETRY_QUEUE_MAX }, (_, i) => `m${i}`);
    const evicted = [];
    await drainBatch(queue, async (item) => {
      if (item === 'm0') queue.push('late1', 'late2');
      return false;
    }, 2, undefined, (x) => evicted.push(x));
    expect(queue).toHaveLength(RETRY_QUEUE_MAX);
    expect(evicted).toEqual(['m0', 'm1']);
  });

  it('no eviction and no onEvict call when the re-queue fits', async () => {
    const queue = ['a', 'b'];
    const evicted = [];
    await drainBatch(queue, async () => false, 2, 5, (x) => evicted.push(x));
    expect(queue).toEqual(['a', 'b']);
    expect(evicted).toEqual([]);
  });

  it('onEvict is optional on the re-queue path', async () => {
    const queue = ['a', 'b'];
    await expect(drainBatch(queue, async () => { queue.push('c'); return false; }, 1, 2)).resolves.toBeDefined();
    expect(queue).toEqual(['b', 'c']);
  });

  it('poller drainLoop passes RETRY_QUEUE_MAX and the cycleEvicted counter to drainBatch', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../poller.mjs', import.meta.url), 'utf8');
    expect(src).toContain('await drainBatch(retryQueue, sendOnce, SEND_CONCURRENCY, RETRY_QUEUE_MAX, () => { cycleEvicted++; });');
    expect(src.match(/cycleEvicted\+\+/g)).toHaveLength(2);
  });
});
