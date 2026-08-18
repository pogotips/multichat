// Bounded queue that's the single outbound path for /ingest/yt POSTs (live
// and recovered messages both go through it) — pure enqueue/drain logic, no
// network, no timers (sendFn is injected). Poller.mjs owns the continuous
// drain loop and backoff schedule.

export const RETRY_QUEUE_MAX = 50;
export const SEND_CONCURRENCY = 4;

// Heartbeats are liveness pings, not chat — they stay outside this queue
// entirely (sent direct, no retry): losing one to a transient outage is
// meaningless (another follows in 15s), and retrying it would just crowd
// out real messages in a bounded queue.
export function isRetryable(msg) {
  return Boolean(msg) && msg.type !== 'heartbeat';
}

export function enqueueRetry(queue, item, maxSize = RETRY_QUEUE_MAX) {
  queue.push(item);
  while (queue.length > maxSize) queue.shift();
  return queue;
}

// Claims up to `concurrency` items off the front of the queue and sends them
// all at once via sendFn (async, returns truthy on success) — this is what
// keeps a cold-boot history burst from opening dozens of simultaneous TLS
// connections. Failures go back at the front, in their original relative
// order, so FIFO dispatch order holds across retries; anything enqueued
// while this batch was in flight lands behind them, untouched.
export async function drainBatch(queue, sendFn, concurrency = SEND_CONCURRENCY) {
  const batch = queue.splice(0, concurrency);
  if (batch.length === 0) return { attempted: 0, sent: 0 };
  const results = await Promise.all(batch.map(async (item) => ({ item, ok: await sendFn(item) })));
  const failed = results.filter((r) => !r.ok).map((r) => r.item);
  queue.unshift(...failed);
  return { attempted: results.length, sent: results.length - failed.length };
}

// Per-attempt counter for ingest send logs (Phase 6 gap: no retry-number
// field existed anywhere in the send path). A WeakMap keyed by message
// identity — not a property stamped on msg itself — so the count never
// gets serialized into the outgoing JSON POST body. Non-object msgs (e.g.
// a bare string in a test double) can't be WeakMap keys; they just always
// read as attempt 1.
const attemptCounts = new WeakMap();

export function nextAttempt(msg) {
  if (!msg || typeof msg !== 'object') return 1;
  const n = (attemptCounts.get(msg) || 0) + 1;
  attemptCounts.set(msg, n);
  return n;
}

// Log-line formatters for sendOnce's two failure paths (poller.mjs) — pulled
// out as pure functions so the attempt=N field's presence/shape is unit-
// tested directly, rather than only the counter it's built from. Ship report
// SHIP_REPORT_2026-08-09_combo.md flagged "attempt=N retry logging never
// observed" — the counter (nextAttempt above) already existed and was
// already wired into both log lines, but nothing pinned the actual log
// string shape, so a live stream was the only way anyone would ever have
// noticed if it silently stopped appearing. These two functions + the tests
// below close that gap without needing live traffic.
export function formatIngestFailureLog(status, bodyText, attempt) {
  return `ingest failed: ${status} ${bodyText} attempt=${attempt}`;
}

export function formatIngestErrorLog(message, attempt) {
  return `ingest error: ${message} attempt=${attempt}`;
}
