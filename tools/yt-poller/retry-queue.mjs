// Bounded queue that's the single outbound path for /ingest/yt POSTs (live
// and recovered messages both go through it) — pure enqueue/drain logic, no
// network, no timers (sendFn is injected). Poller.mjs owns the continuous
// drain loop and backoff schedule.

export const RETRY_QUEUE_MAX = 50;
export const SEND_CONCURRENCY = 4;

// Heartbeats are liveness pings, not chat — they stay outside this queue
// entirely (sent direct, no retry): losing one to a transient outage is
// meaningless (another follows in 15s), and retrying it would just crowd
// out real messages in a bounded queue. yt_reactions status pushes are the
// same shape of thing — a live snapshot superseded within seconds by the
// next poll — so a stale retry would just crowd the queue for no benefit.
export function isRetryable(msg) {
  return Boolean(msg) && msg.type !== 'heartbeat' && msg.type !== 'yt_reactions';
}

// onEvict (optional): called once per item shifted off the front to honor
// maxSize, with that item — lets the caller count/log an overflow that would
// otherwise drop chat silently. Return value is unchanged (the queue).
export function enqueueRetry(queue, item, maxSize = RETRY_QUEUE_MAX, onEvict) {
  queue.push(item);
  return evictOverflow(queue, maxSize, onEvict);
}

// The one overflow policy for every path that adds to the queue: the OLDEST
// items (front) go first, each reported to onEvict. enqueueRetry (push at the
// back) and drainBatch's re-queue (unshift at the front) both end here, so
// neither can leave the queue past maxSize.
function evictOverflow(queue, maxSize, onEvict) {
  while (queue.length > maxSize) {
    const evicted = queue.shift();
    if (typeof onEvict === 'function') onEvict(evicted);
  }
  return queue;
}

// HTTP status of each message's most recent failed send. sendOnce records it
// (noteSendStatus) because sendFn only returns truthy/falsy; drainBatch reads
// it to tell a payload rejection from a transient failure. A WeakMap for the
// same reason as attemptCounts below: nothing is stamped on the msg, so it can
// never leak into the outgoing JSON body. A network error records nothing —
// sendOnce clears the entry first (status undefined), so a stale status from an
// earlier attempt can never turn a later network error into a drop.
const lastStatus = new WeakMap();

export function noteSendStatus(msg, status) {
  if (!msg || typeof msg !== 'object') return;
  if (status === undefined) lastStatus.delete(msg);
  else lastStatus.set(msg, status);
}

// Statuses the Worker ingest route answers purely from the request body, so a
// retry can only get the same answer: 400 (bad json / unknown type / bad shape
// — DO handleIngestYt) and 413 (over INGEST_MAX_BYTES). Deliberately NOT
// 401/403/404 (secret rotation, caller scope, Worker not deployed yet — all
// fixed by an operator, and the chat must survive until then), nor 408/429/5xx.
export function isPayloadRejection(status) {
  return status === 400 || status === 413;
}

// Claims up to `concurrency` items off the front of the queue and sends them
// all at once via sendFn (async, returns truthy on success) — this is what
// keeps a cold-boot history burst from opening dozens of simultaneous TLS
// connections. Failures go back at the front, in their original relative
// order, so FIFO dispatch order holds across retries; anything enqueued
// while this batch was in flight lands behind them, untouched. The one
// exception is a payload rejection (isPayloadRejection): it is dropped with
// one structured log line instead of requeued, so a single poisoned item can't
// block the chat queued behind it. A dropped item is not a transient failure:
// it is reported in `dropped` (separate from `sent`) so the caller's backoff
// only reacts to failures a retry could fix.
// The re-queue below can push the queue past maxSize (items enqueued while the
// batch was in flight sit behind the failed ones), so it trims with the same
// policy as enqueueRetry; onEvict is the same optional per-item callback.
export async function drainBatch(queue, sendFn, concurrency = SEND_CONCURRENCY, maxSize = RETRY_QUEUE_MAX, onEvict) {
  const batch = queue.splice(0, concurrency);
  if (batch.length === 0) return { attempted: 0, sent: 0, dropped: 0 };
  const results = await Promise.all(batch.map(async (item) => ({ item, ok: await sendFn(item) })));
  const failed = [];
  let dropped = 0;
  for (const { item, ok } of results) {
    if (ok) continue;
    const status = item && typeof item === 'object' ? lastStatus.get(item) : undefined;
    if (isPayloadRejection(status)) {
      // No body, URL or headers — type and an id only.
      console.log(JSON.stringify({ ev: 'ingest_dropped', status, type: item.type ?? null, id: item.ytId ?? item.authorId ?? null }));
      dropped++;
      continue;
    }
    failed.push(item);
  }
  queue.unshift(...failed);
  evictOverflow(queue, maxSize, onEvict);
  return { attempted: results.length, sent: results.filter((r) => r.ok).length, dropped };
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
// tested directly, rather than only the counter it's built from. An internal
// ship report (2026-08-09) flagged "attempt=N retry logging never
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
