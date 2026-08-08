#!/usr/bin/env node
// Watches the streamer's current YouTube live chat and forwards normalized
// messages to the multichat Worker's /ingest/yt endpoint.
//
// Uses `youtube-chat` (innertube-based scraper, no API key/quota cost),
// locally patched via patch-package (patches/) to mark membership items and
// parse membership-gift renderers the stock parser drops — `npm install`
// (postinstall) must run before `npm start` for those events to flow.
// If this library proves unmaintained/broken, switch to the official
// `liveChatMessages.list` polling endpoint instead — that requires an API
// key + a `liveChatId` lookup and burns YouTube Data API quota on every
// poll (each `liveChatMessages.list` call costs quota units, and the
// response's `pollingIntervalMillis` should be respected — polling faster
// than that risks 403/quotaExceeded on an active stream).
//
// Env:
//   YT_CHANNEL_ID             YouTube channel id, e.g. "UCxxxxxxxxxxxxxxxxxxxxxx"
//   MULTICHAT_URL             Base URL of the multichat worker, e.g. "https://multichat.example.com"
//   MULTICHAT_INGEST_SECRET   Shared secret (same value as the MULTICHAT_INGEST_SECRET wrangler secret)
//   YOUTUBE_API_KEY           Optional. Data API key for live-counts (videos.list,
//                             1 quota unit/poll, only spent while a session is live).
//                             Absent = counts feature is simply off; chat is unaffected.

import path from 'node:path';
import { LiveChat } from 'youtube-chat';
import { normalizeChatItem } from './normalize.mjs';
import { classifyYtItem } from './recovery.mjs';
import { enqueueRetry, drainBatch, isRetryable, RETRY_QUEUE_MAX, SEND_CONCURRENCY, nextAttempt } from './retry-queue.mjs';
import { bumpCount, appendCapture, CAPTURE_DIR, CAPTURE_FILE } from './capture.mjs';
import { createVideoIdTracker, fetchYtCounts } from './yt-counts.mjs';

const { YT_CHANNEL_ID, MULTICHAT_URL, MULTICHAT_INGEST_SECRET, YOUTUBE_API_KEY } = process.env;

if (!YT_CHANNEL_ID || !MULTICHAT_URL || !MULTICHAT_INGEST_SECRET) {
  console.error('Missing required env: YT_CHANNEL_ID, MULTICHAT_URL, MULTICHAT_INGEST_SECRET');
  process.exit(1);
}
// YOUTUBE_API_KEY is optional: absent means counts simply never populate
// (chat/heartbeat delivery is unaffected either way).

const INGEST_URL = MULTICHAT_URL.replace(/\/$/, '') + '/ingest/yt';

// Concurrent-viewers + like-count tracking — see yt-counts.mjs. Gated on
// CURRENTLY holding a live video id (never the last-known one), so an ended
// stream's stats can't keep flowing and quota is only spent while actually
// live. The id comes straight off youtube-chat's own `start` event
// (LiveChat.liveId, resolved via fetchLivePage) — no search.list, no second
// discovery call.
const videoIdTracker = createVideoIdTracker();

const MAX_BACKOFF_MS = 60_000;
let backoffMs = 2000;

// "Live Stream was not found" means the stream literally isn't live yet —
// there is no load to back off from, so growing this exponentially (it was
// settling at MAX_BACKOFF_MS=60s) only adds pure discovery lag at stream
// start. 2026-07-20's incident: this error repeated for ~8-9 minutes at
// stream start while backoff climbed toward 60s. A constant, short retry
// cadence bounds discovery lag to ~this + YouTube's own propagation delay.
// 20s (top of the 15-20s target range, not 15s) — this cadence also applies
// 24/7 while the channel is offline (1,884 not-found hits over 38h per the
// triage), and pre-deploy review flagged that a fixed 15s sustained forever
// trades stream-start latency for steady-state YouTube rate-limit exposure.
// Scoped to this one error message so real errors (rate limits, auth,
// network) keep the exponential backoff they actually need.
const NOT_FOUND_BACKOFF_MS = 20_000;

// Dedupe cache spans the whole process lifetime (survives reconnects) — its
// entire purpose is catching items a new session's history burst re-sends
// that a prior session already delivered.
const seenYtIds = new Set();

// Fixture harvesting for unrecognized renderer types (Jewels, and whatever
// YT ships after it) — counts are cumulative for the process lifetime and
// ride the heartbeat payload; raw items land in a bounded JSONL capture file.
const unknownRendererCounts = {};
const CAPTURE_PATH = path.join(CAPTURE_DIR, CAPTURE_FILE);

// Single send path for every non-heartbeat message (live and recovered
// alike) — this is what kills the cold-boot stampede: without it, a history
// burst's items each open their own concurrent TLS connection via a bare
// fetch(), and enough of them at once starve each other past the 10s
// timeout even though the worker answers every one in single-digit ms
// (observed live: 27 concurrent posts on cold boot, all client-side timeout,
// zero server-side failures). Routing through the queue caps how many are
// ever in flight at once.
const retryQueue = [];
const RETRY_BACKOFF_INITIAL_MS = 5_000;
const RETRY_BACKOFF_MAX_MS = 60_000;
let retryBackoffMs = RETRY_BACKOFF_INITIAL_MS;

// Per-heartbeat-cycle counters for the poller_heartbeat log (see the
// setInterval below) — reset every 15s alongside it. One bounded log line
// per cycle; log silence itself, not these numbers, is the primary
// "is the poller alive" signal. cyclePosted counts post() attempts, not
// confirmed deliveries — retry re-sends go through sendOnce directly (via
// drainBatch), never back through post(), so they can't inflate this past
// cycleFetched. cycleFailed counts sendOnce failures and does include retry
// re-attempts, since a retry storm this cycle is itself useful signal.
let cycleFetched = 0;
let cyclePosted = 0;
let cycleFailed = 0;

// forensics rec 4 (YT_FEED_LOSS_FORENSICS_2026-08-05.md): heartbeat-payload
// health fields + the empty-200 zombie watchdog. lastChatAt/liveChatSessionActive/
// currentLiveChat are module-level (not run()-scoped) because the heartbeat
// setInterval below is itself module-level and outlives any single run()
// call/reconnect — they're the bridge between a run()-scoped LiveChat session
// and the persistent heartbeat cadence.
let lastChatAt = null;           // ms epoch of the last real chat item, across reconnects
let liveChatSessionActive = false; // true only between a session's 'start' and 'end'
let currentLiveChat = null;        // current run()'s LiveChat instance, for the watchdog's forced-reconnect
let zeroStreak = 0;                // consecutive ungated heartbeat cycles with cycleFetched===0 while a session is active
// 3 min conservative: the 2026-08-05 quiet stretch had isolated zero-message
// minutes (00:34, 00:36, 00:41) interspersed with 1-3 msg/min minutes, never
// three *consecutive* zero minutes — this threshold would not have false-fired
// that night.
const ZOMBIE_WATCHDOG_MIN = 3;
const ZOMBIE_WATCHDOG_CYCLES = (ZOMBIE_WATCHDOG_MIN * 60_000) / 15_000; // heartbeat cadence, 15s

// Ingest-tail RTT tracking (Phase 3) — RTT is
// measured entirely on this process's own clock (performance.now(), never
// diffed against a worker-side timestamp — that would measure clock skew
// between two machines, not latency). Reset every 15s alongside the counters
// above; folds into the same poller_heartbeat line rather than a new log
// stream. Every sendOnce() attempt counts, success or failure — a
// client-side timeout is itself latency evidence.
const RTT_BUCKET_KEYS = ['lt100', 'lt250', 'lt500', 'lt1s', 'lt2s', 'lt5s', 'lt10s', 'gte10s'];
function freshRttBuckets() {
  return Object.fromEntries(RTT_BUCKET_KEYS.map((k) => [k, 0]));
}
let cycleRttBuckets = freshRttBuckets();
let cycleRttMaxMs = 0;
let cycleRttCount = 0;

function rttBucketFor(ms) {
  if (ms < 100) return 'lt100';
  if (ms < 250) return 'lt250';
  if (ms < 500) return 'lt500';
  if (ms < 1000) return 'lt1s';
  if (ms < 2000) return 'lt2s';
  if (ms < 5000) return 'lt5s';
  if (ms < 10000) return 'lt10s';
  return 'gte10s';
}

function recordRtt(ms) {
  cycleRttCount++;
  if (ms > cycleRttMaxMs) cycleRttMaxMs = ms;
  cycleRttBuckets[rttBucketFor(ms)]++;
}

// Short, not cryptographic — only needs to be unique enough to join against
// the DO's ingest_timing log for this one request within the same window.
function randReqId() {
  return Math.random().toString(36).slice(2, 10);
}

// Single POST attempt, no queue side effects — used as the sendFn drainBatch
// calls back into, and directly for heartbeats (which never touch the queue).
async function sendOnce(msg) {
  const reqId = randReqId();
  const attempt = nextAttempt(msg);
  const rttStart = performance.now();
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Multichat-Secret': MULTICHAT_INGEST_SECRET,
        'X-Req-Id': reqId,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10_000),
    });
    recordRtt(performance.now() - rttStart);
    if (!res.ok) {
      console.error(`ingest failed: ${res.status} ${await res.text()} attempt=${attempt}`);
      if (msg.type !== 'heartbeat') cycleFailed++;
    }
    return res.ok;
  } catch (err) {
    recordRtt(performance.now() - rttStart);
    console.error(`ingest error: ${err.message} attempt=${attempt}`);
    if (msg.type !== 'heartbeat') cycleFailed++;
    return false;
  }
}

// `draining` guards re-entrancy for the whole async body (not just a
// setTimeout wait), so a post() landing mid-drain can never start a second
// overlapping loop racing the same queue.
let draining = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function drainLoop() {
  if (draining) return;
  draining = true;
  try {
    while (retryQueue.length > 0) {
      const { attempted, sent } = await drainBatch(retryQueue, sendOnce, SEND_CONCURRENCY);
      if (attempted === 0) break;
      if (sent < attempted) {
        // Any failure in the batch backs off before the next one — a steady
        // partial-failure state (some succeed, some fail every round) would
        // otherwise retry with zero delay between batches and hammer a
        // degraded endpoint. Only a fully clean batch resets to the floor.
        retryBackoffMs = Math.min(retryBackoffMs * 2, RETRY_BACKOFF_MAX_MS);
        await sleep(retryBackoffMs);
      } else {
        retryBackoffMs = RETRY_BACKOFF_INITIAL_MS;
      }
    }
  } finally {
    draining = false;
  }
}

async function post(msg) {
  if (msg.type !== 'heartbeat') cyclePosted++;
  if (!isRetryable(msg)) {
    // Heartbeat: direct send, no queue, no retry — see isRetryable's comment.
    // Return value used only by the heartbeat caller below; every other
    // caller of post() still fires-and-forgets it, same as before.
    return sendOnce(msg);
  }
  enqueueRetry(retryQueue, msg, RETRY_QUEUE_MAX);
  drainLoop(); // fire-and-forget: draining guard makes repeated calls free
}

// "not live yet" — no load to back off from; retry on a short constant cadence.
function isStreamNotFound(msg) {
  return typeof msg === 'string' && /stream was not found/i.test(msg);
}

// delayMs given → use it verbatim and do NOT grow the exponential backoff (the
// not-live-yet case). Omitted → normal exponential backoff for real errors.
function scheduleReconnect(delayMs) {
  const delay = delayMs != null ? delayMs : backoffMs;
  console.error(`reconnecting in ${delay}ms`);
  setTimeout(run, delay);
  if (delayMs == null) backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

// youtube-chat's poll loop doesn't self-heal from a broken chat session (a
// stale/invalid continuation token from its unofficial page-scraping) — on
// error it just logs and keeps polling the same session forever. Seen live:
// hours of "Request failed with status code 400" with zero chat delivered,
// only cleared by a manual restart. Force that same recovery automatically.
const MAX_CONSECUTIVE_ERRORS = 8;

// True from the second run() call onward in this process — the first call
// is a cold boot (nothing to recover), every call after is a reconnect
// (natural 'end' or the forced reconnect above), matching hasConnectedOnce
// in the worker's own gap-recovery gate.
let hasRunBefore = false;

async function run() {
  const isReconnect = hasRunBefore;
  hasRunBefore = true;
  // Reset here, not just in the 'end' handler below — a failed start() (e.g.
  // "Stream was not found") never fires 'end', so without this a stale id
  // from a PRIOR session would otherwise survive into a run() that never
  // actually attaches to anything live.
  videoIdTracker.reset();
  const liveChat = new LiveChat({ channelId: YT_CHANNEL_ID });
  currentLiveChat = liveChat;
  let consecutiveErrors = 0;
  // armedAt is set from the 'start' event, not here — that's the moment this
  // session actually establishes, before any chat items can arrive (the
  // library's first poll tick fires `interval` ms later).
  let ephemeral = { armed: isReconnect, armedAt: null, recoveredCount: 0 };
  let lastErrorMsg = null; // last error seen this session — routes the reconnect cadence

  liveChat.on('start', (liveId) => {
    videoIdTracker.onStart(liveId); // youtube-chat resolves this itself — never a search.list call
    if (isReconnect) ephemeral = { ...ephemeral, armedAt: Date.now() };
    liveChatSessionActive = true;
    zeroStreak = 0; // clean slate for the new session
  });

  liveChat.on('chat', (item) => {
    consecutiveErrors = 0;
    cycleFetched++;
    lastChatAt = Date.now();
    // 'unknown' = an addChatItemAction whose item renderer we've never seen;
    // 'unknownAction' = a top-level action key we've never seen (see the
    // patch). Same capture sink for both — closes the gap for both classes.
    if (item.rendererType === 'unknown' || item.rendererType === 'unknownAction') {
      bumpCount(unknownRendererCounts, item.unknownType);
      try {
        // 'unknown' item.raw is the renderer's own payload (item[key]) — wrap
        // by key so the captured line matches the fixture convention used
        // elsewhere (test/fixtures/*.json), copy-pasteable. 'unknownAction'
        // item.raw is already the full action object (see the patch) —
        // written unwrapped so every sibling key (e.g. clickTrackingParams)
        // survives instead of being re-nested under a duplicate copy of the
        // chosen key.
        const captured = item.rendererType === 'unknownAction' ? item.raw : { [item.unknownType]: item.raw };
        appendCapture(CAPTURE_PATH, captured);
      } catch (err) {
        // Disk full / unwritable dir: telemetry is best-effort, must never
        // take the whole poller down over it.
        console.error(`capture write failed: ${err.message}`);
      }
      return;
    }
    // Mod-action control messages — bypass classifyYtItem/normalizeChatItem
    // entirely (these aren't ChatItems); routed through the same post()/queue
    // path as chat so they share retry/backoff behavior, never fire-and-forget.
    if (item.rendererType === 'deletion') {
      post({ type: 'mod', action: 'delete', ytId: item.targetId });
      return;
    }
    if (item.rendererType === 'authorDeletion') {
      post({ type: 'mod', action: 'author_delete', authorId: item.authorChannelId });
      return;
    }
    // ROOMSTATE parity: slow/sub-only/emote-only toggles — gray info row, no
    // classification, same control-item path as the deletions above. Empty
    // text (a shape the renderer isn't expected to produce, but the
    // extraction can't rule out) is dropped rather than posting a blank row.
    if (item.rendererType === 'modeChange') {
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (text) post({ type: 'mod', action: 'mode_change', text });
      return;
    }
    const result = classifyYtItem(item, ephemeral, seenYtIds);
    ephemeral = result.ephemeral;
    if (!result.send) return;
    const msg = normalizeChatItem(item);
    if (!msg) return;
    if (result.recovered) msg.recovered = true;
    post(msg);
  });

  liveChat.on('error', (err) => {
    lastErrorMsg = err?.message ?? String(err);
    console.error(`live chat error: ${lastErrorMsg}`);
    consecutiveErrors++;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`${consecutiveErrors} consecutive errors — forcing reconnect`);
      liveChat.stop('too many consecutive errors');
    }
  });

  liveChat.on('end', () => {
    videoIdTracker.onEnd(); // session's gone — stop spending quota on an ended stream's stats
    liveChatSessionActive = false; // idle until the next 'start' — zombie watchdog must not count offline silence
    console.error('live chat ended (stream offline, or forced reconnect after errors) — retrying');
    scheduleReconnect(isStreamNotFound(lastErrorMsg) ? NOT_FOUND_BACKOFF_MS : undefined);
  });

  const started = await liveChat.start().catch((err) => {
    lastErrorMsg = err?.message ?? String(err);
    console.error(`failed to start: ${lastErrorMsg}`);
    return false;
  });

  if (started) {
    backoffMs = 2000; // reset backoff once we successfully attach
  } else {
    scheduleReconnect(isStreamNotFound(lastErrorMsg) ? NOT_FOUND_BACKOFF_MS : undefined);
  }
}

// Proves the poller container itself is alive, independent of whether a
// live chat session is currently attached — multichat's status chip uses this.
// Counts ride the same payload when a live session holds a current video id;
// fetchYtCounts resolves to null (no fields added) whenever it doesn't, so a
// heartbeat during an offline stretch is byte-for-byte what it was before
// this feature existed. This interval is NOT live-gated — it runs on this
// same 15s cadence whether a stream is live or not, so silence in the
// poller_heartbeat log below always means the poller process itself died,
// never just "stream is offline".
setInterval(async () => {
  const videoId = videoIdTracker.get();
  const counts = await fetchYtCounts(videoId, YOUTUBE_API_KEY);
  // Classified here, not inside fetchYtCounts, so its heartbeat payload
  // contract (null = zero fields, never a special case) stays untouched —
  // zero ingest surface change. skip = feature not configured/not live (both
  // fetchYtCounts no-op on the same check); err = key+videoId present but the
  // call still came back empty (quota death, revoked key, malformed
  // response) — previously indistinguishable from "not live" and silent.
  const countsOutcome = (!YOUTUBE_API_KEY || !videoId) ? 'skip' : (counts ? 'ok' : 'err');
  const lastMessageAgeSec = lastChatAt ? Math.round((Date.now() - lastChatAt) / 1000) : null;
  const status = await post({
    type: 'heartbeat',
    unknownRenderers: { ...unknownRendererCounts },
    fetched: cycleFetched,
    lastMessageAgeSec,
    ...(counts || {}),
  });
  console.log(JSON.stringify({
    ev: 'poller_heartbeat',
    fetched: cycleFetched,
    posted: cyclePosted,
    failed: cycleFailed,
    status,
    counts: countsOutcome,
    rtt_buckets: cycleRttBuckets,
    rtt_max_ms: Math.round(cycleRttMaxMs),
    rtt_count: cycleRttCount,
  }));
  // forensics rec 4: empty-200 zombie watchdog. Gated on liveChatSessionActive
  // — this heartbeat interval is deliberately NOT live-gated (see comment
  // above), so cycleFetched===0 is the normal, permanent state whenever
  // there's no stream at all; ungated, this would force a "reconnect" every
  // ZOMBIE_WATCHDOG_MIN minutes all night, every night, with no stream up.
  // Both a real stuck-continuation zombie and genuinely dead-quiet chat look
  // identical from fetched=0 alone — forcing a continuation refresh is
  // cheap/safe either way (same path real errors already use), so this
  // doesn't need to (and can't) tell them apart.
  if (liveChatSessionActive) {
    if (cycleFetched === 0) {
      zeroStreak++;
      if (zeroStreak >= ZOMBIE_WATCHDOG_CYCLES) {
        console.log(JSON.stringify({ ev: 'zombie_watchdog_reconnect', zeroStreakMin: ZOMBIE_WATCHDOG_MIN }));
        zeroStreak = 0; // avoid a second immediate fire before 'end' flips liveChatSessionActive
        currentLiveChat?.stop('zombie watchdog: sustained fetched=0');
      }
    } else {
      zeroStreak = 0;
    }
  } else {
    zeroStreak = 0; // idle/offline — explicit reset, not just "don't increment"
  }
  cycleFetched = 0;
  cyclePosted = 0;
  cycleFailed = 0;
  cycleRttBuckets = freshRttBuckets();
  cycleRttMaxMs = 0;
  cycleRttCount = 0;
}, 15_000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

run();
