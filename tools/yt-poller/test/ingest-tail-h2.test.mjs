// Phase 4b discriminating test (main repo).
// H2 = poller-side head-of-line blocking: a retrying message's backoff sleep
// delays every OTHER message queued behind it, entirely inside the poller
// process — no DO involvement at all.
//
// `drainLoop` (poller.mjs:178-199) isn't exported (per the branch's own
// documented decision — see "Decisions I made for you" in the findings doc:
// exporting poller.mjs internals risked the Dockerfile-COPY invariant for a
// small helper). This test reimplements drainLoop's exact algorithm inline —
// same shape as the source, quoted below for traceability — driving it with
// the REAL exported `drainBatch`/`enqueueRetry` from retry-queue.mjs, not a
// reimplementation of those. If poller.mjs's actual drainLoop ever diverges
// from this shape, only this test's fidelity to the source comment is at
// risk, not the mechanism under test (drainBatch itself is exercised for
// real).
//
//   while (retryQueue.length > 0) {
//     const { attempted, sent } = await drainBatch(retryQueue, sendOnce, SEND_CONCURRENCY);
//     if (attempted === 0) break;
//     if (sent < attempted) {
//       retryBackoffMs = Math.min(retryBackoffMs * 2, RETRY_BACKOFF_MAX_MS);
//       await sleep(retryBackoffMs);
//     } else {
//       retryBackoffMs = RETRY_BACKOFF_INITIAL_MS;
//     }
//   }
import { describe, it, expect } from 'vitest';
import { enqueueRetry, drainBatch, SEND_CONCURRENCY } from '../retry-queue.mjs';

// Real production values are 5_000/60_000 (poller.mjs:88-89) — this test
// uses a scaled-down backoff (see `initialBackoffMs` param) purely for test
// speed; the mechanism under test (does something queued behind a retry
// get delayed by ~the backoff window, using real timers, not mocked ones)
// is identical regardless of the constant's magnitude.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drainLoopMirror(queue, sendFn, initialBackoffMs, maxBackoffMs) {
  let retryBackoffMs = initialBackoffMs;
  const timeline = []; // { item, startedAtMs } — when sendFn was actually invoked
  const timedSendFn = async (item) => {
    timeline.push({ item, startedAtMs: Date.now() });
    return sendFn(item);
  };
  while (queue.length > 0) {
    const { attempted, sent } = await drainBatch(queue, timedSendFn, SEND_CONCURRENCY);
    if (attempted === 0) break;
    if (sent < attempted) {
      retryBackoffMs = Math.min(retryBackoffMs * 2, maxBackoffMs);
      await sleep(retryBackoffMs);
    } else {
      retryBackoffMs = initialBackoffMs;
    }
  }
  return timeline;
}

describe('Phase 4b: H2 head-of-line-blocking fingerprint', () => {
  const INITIAL_BACKOFF_MS = 200; // scaled down from poller.mjs's real 5,000ms — see file header
  const MAX_BACKOFF_MS = 2_000;

  it('a message queued behind a failing/retrying one is delayed by the full backoff — H2 predicted shape', async () => {
    const queue = [];
    // SEND_CONCURRENCY is 4 — msgA alone fills a batch by itself so its
    // retry cleanly gates the next batch, matching the "one retrying
    // message delays everyone behind it" claim (not diluted by unrelated
    // concurrent sends in the same batch).
    enqueueRetry(queue, 'msgA');

    let msgAAttempts = 0;
    const sendFn = async (item) => {
      if (item === 'msgA') {
        msgAAttempts++;
        return msgAAttempts >= 2; // fails once, succeeds on retry
      }
      return true; // everything else succeeds first try
    };

    const loopPromise = drainLoopMirror(queue, sendFn, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS);
    // msgB arrives (post()) partway into msgA's backoff sleep — same as a
    // live chat message arriving while the poller is already backing off.
    await sleep(INITIAL_BACKOFF_MS / 4);
    enqueueRetry(queue, 'msgB');

    const timeline = await loopPromise;

    const aFirst = timeline.find((t) => t.item === 'msgA');
    const aRetry = timeline.filter((t) => t.item === 'msgA')[1];
    const b = timeline.find((t) => t.item === 'msgB');
    expect(aFirst).toBeTruthy();
    expect(b).toBeTruthy();
    // The fingerprint: msgB's actual send is delayed by ~msgA's full backoff
    // window, not by its own (instant) network time — it was ready
    // immediately but sat behind msgA's retry.
    expect(b.startedAtMs - aFirst.startedAtMs).toBeGreaterThanOrEqual(INITIAL_BACKOFF_MS * 0.9);
    // And it resolves in the SAME batch as msgA's successful retry — msgB
    // was never itself slow, it was just queued.
    expect(aRetry.startedAtMs).toBe(b.startedAtMs);
  });

  it('a clean batch (no failures) does not delay anything queued behind it — control', async () => {
    const queue = [];
    enqueueRetry(queue, 'msgA');
    enqueueRetry(queue, 'msgB');
    const sendFn = async () => true;
    const started = Date.now();
    const timeline = await drainLoopMirror(queue, sendFn, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS);
    // Both attempted essentially immediately, no backoff — msgB never had
    // to wait behind anything, since msgA never failed.
    expect(timeline.length).toBe(2);
    expect(Date.now() - started).toBeLessThan(INITIAL_BACKOFF_MS / 2);
  });
});
