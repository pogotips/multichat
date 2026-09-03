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
import { normalizeChatItem, takeGlobalEmojiRenderCount } from './normalize.mjs';
import { classifyYtItem } from './recovery.mjs';
import {
  enqueueRetry, drainBatch, isRetryable, RETRY_QUEUE_MAX, SEND_CONCURRENCY, nextAttempt,
  formatIngestFailureLog, formatIngestErrorLog,
} from './retry-queue.mjs';
import { bumpCount, appendCapture, CAPTURE_DIR, CAPTURE_FILE } from './capture.mjs';
import { createVideoIdTracker, fetchYtVideoState } from './yt-counts.mjs';
import { probeCurrentLiveId, createRediscoveryGate, resolveRediscoveryOutcome } from './rediscovery.mjs';

const { YT_CHANNEL_ID, MULTICHAT_URL, MULTICHAT_INGEST_SECRET, YOUTUBE_API_KEY, WATCHDOG_LIVENESS_GATE: WATCHDOG_LIVENESS_GATE_RAW } =
  process.env;
// round-3 audit kill switch (FIX 3): default on; set to the literal string
// 'off' to fall back to the pre-liveness-gate behavior instantly via Dockge
// (env edit + container recreate), no rebuild/rsync needed to recover from a
// misbehaving gate mid-stream. Wired to the same "liveness unavailable" path
// as no-API-key/no-videoId below — 'gate_off' is a fourth value alongside
// 'live'/'not_live'/'unknown' so heartbeat consumers can tell "off on
// purpose" from "couldn't determine liveness this cycle".
const WATCHDOG_LIVENESS_GATE = WATCHDOG_LIVENESS_GATE_RAW !== 'off';

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
//
// Change 3 (round-3 audit — do NOT rename `fetched`, it ships in the
// /ingest/yt heartbeat body and is logged Worker-side as
// ev:'yt_poller_health'; renaming breaks saved observability queries and
// opens a poller/Worker version-skew window): cycleFetched counts raw
// youtube-chat library 'chat' events PRE-DEDUPE, including the history
// re-burst a fresh reconnect's continuation re-serves — it is not "messages
// delivered". `cyclePosted`/`posted` is the field that answers that
// question; two rounds of this audit misread fetched:0 as "chat is dead"
// when it is also the expected steady state for live-but-silent chat. See
// README.md for the same distinction.
let cycleFetched = 0;
let cyclePosted = 0;
let cycleFailed = 0;
// Drained from normalize.mjs's non-sampled counter each cycle — see
// takeGlobalEmojiRenderCount there for why this exists alongside the
// existing 2%-sampled yt_global_emoji_render log.
let cycleGlobalEmojiRenders = 0;

// forensics rec 4 (internal doc, 2026-08-05): heartbeat-payload
// health fields + the empty-200 zombie watchdog. lastChatAt/liveChatSessionActive/
// currentLiveChat are module-level (not run()-scoped) because the heartbeat
// setInterval below is itself module-level and outlives any single run()
// call/reconnect — they're the bridge between a run()-scoped LiveChat session
// and the persistent heartbeat cadence.
let lastChatAt = null;           // ms epoch of the last real chat item, across reconnects
let liveChatSessionActive = false; // true only between a session's 'start' and 'end'
let currentLiveChat = null;        // current run()'s LiveChat instance, for the watchdog's forced-reconnect
let zeroStreak = 0;                // consecutive ungated heartbeat cycles with cycleFetched===0 while a session is active
// Bumped on every 'start' — lets an in-flight rediscovery probe (up to 8s)
// notice a session swap happened underneath it and discard its own result
// instead of tearing down a session it was never actually measuring.
let sessionGeneration = 0;
// The heartbeat interval and the counts/liveness poll are the same tick —
// see the setInterval below. Every other *_MS/*_CYCLES constant here is
// derived from this one so they can never drift out of sync with the actual
// cadence (FIX 2 of the round-3 audit: an assumed-but-unverified interval
// would silently age out every liveness sample and turn the gate into a
// no-op). Guarded by a source-text regression test
// (test/heartbeat-interval.test.mjs) rather than a runtime assertion, since
// poller.mjs isn't import-safe in a test process (see zombie-watchdog.test.mjs).
const HEARTBEAT_INTERVAL_MS = 15_000;

// Round-3 audit (YT "stall" burst re-audit): the original single 3-min
// threshold false-fired on 254/279 observed watchdog events because
// liveChatSessionActive only means "a chat session attached", which YouTube
// grants for waiting rooms that never go live — see the plan doc. Liveness
// (from fetchYtVideoState, below) now SELECTS which threshold zeroStreak is
// compared against; it never suppresses the watchdog outright. Suppressing
// on `not_live` was the first-pass design and was rejected: the watchdog and
// MAX_CONSECUTIVE_ERRORS below are the *only* two paths back to a fresh
// fetchLivePage() call, and a rescheduled-but-undeleted waiting room
// produces no errors — suppression would leave the poller polling a dead
// continuation with no way out, losing chat for an entire subsequent stream.
//
// ZOMBIE_WATCHDOG_MIN (15 min) — the live/unknown backstop, i.e. "a real
// stuck continuation on a broadcast that might actually have chat to lose".
// `unknown` deliberately takes this same patient threshold, never the
// rediscovery one, so an ambiguous liveness read can only ever make the
// watchdog *more* patient (fail open). Derived from a full week's measured
// quiet-tail inside genuinely live chat: longest observed gap between
// posted>0 heartbeat cycles was 540s (9m00s); 15 min is 1.67x that.
const ZOMBIE_WATCHDOG_MIN = 15;
const ZOMBIE_WATCHDOG_CYCLES = (ZOMBIE_WATCHDOG_MIN * 60_000) / HEARTBEAT_INTERVAL_MS;

// REDISCOVERY_MIN (5 min) — the not_live path: liveness has positively
// confirmed there's no broadcast to lose chat from. REFINEMENT 3: this is
// now a CHECK cadence, not a teardown cadence — every REDISCOVERY_MIN, a
// throwaway probe (rediscovery.mjs) re-resolves the channel's current live
// videoId and compares it to the one this run() is holding; the real
// session is only ever torn down if that id genuinely changed. First-pass
// value went 12 -> 2 -> 5 across three revisions of this same audit: 12 was
// too patient (a real new stream could lose 12 minutes of its opening
// chat); 2 priced only the dedupe/reattach cost a full teardown-every-cycle
// design carried and ignored the OTHER cost — the probe itself still
// spends one fetchLivePage call every cycle regardless of outcome, and
// sustained scraping is the one failure mode that could get discovery
// throttled or blocked outright (which costs an entire stream, not a few
// minutes of one). check-then-act (below) fully retires the dedupe cost;
// it does nothing for the scrape-frequency cost, which is why this stayed
// at 5 rather than returning to 2 once check-then-act became reachable.
// Kept well below ZOMBIE_WATCHDOG_MIN so a stale waiting room is never more
// patient than a confirmed-live session. Logged under its own event name,
// yt_rediscovery, never zombie_watchdog_reconnect — this path is
// expected/near-zero-cost in the common case, not a health signal, and
// conflating the two was the original complaint this audit was chasing.
const REDISCOVERY_MIN = 5;
const REDISCOVERY_CYCLES = (REDISCOVERY_MIN * 60_000) / HEARTBEAT_INTERVAL_MS;
// Independent cadence + single-flight gate for the probe itself (HIGH
// finding, round-3 audit review round): the old design self-reset via a
// full teardown on every fire ('end' -> fresh run() -> zeroStreak restart).
// check-then-act removed that teardown in the common case, so nothing
// else guaranteed probe spacing if the zeroStreak reset around the
// no-teardown path were ever wrong in a future edit — this gate makes
// spacing correct on its own, independent of that bookkeeping.
const rediscoveryGate = createRediscoveryGate({ minIntervalMs: REDISCOVERY_MIN * 60_000 });

// Legacy single threshold, used only when WATCHDOG_LIVENESS_GATE=off (FIX 3)
// — byte-for-byte the pre-round-3-audit behavior, so flipping the kill
// switch is a true rollback, not a different design at a different number.
const LEGACY_ZOMBIE_WATCHDOG_MIN = 3;
const LEGACY_ZOMBIE_WATCHDOG_CYCLES = (LEGACY_ZOMBIE_WATCHDOG_MIN * 60_000) / HEARTBEAT_INTERVAL_MS;

// Change 2 / FIX 2: a liveness sample older than this reads as 'unknown'
// rather than being trusted — since 'unknown' always takes the patient
// 15-min path (never a suppression), a frozen or cached sample can only ever
// make the watchdog MORE patient, never hold it off indefinitely. In the
// current wiring the sample is always produced and consumed in the same
// setInterval tick (age ~0), so this is defense-in-depth against a future
// refactor that decouples the two, not a control that fires today.
const LIVENESS_MAX_AGE_MS = 4 * HEARTBEAT_INTERVAL_MS;
let lastLiveness = { state: 'unknown', at: 0 };

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
      console.error(formatIngestFailureLog(res.status, await res.text(), attempt));
      if (msg.type !== 'heartbeat') cycleFailed++;
    }
    return res.ok;
  } catch (err) {
    recordRtt(performance.now() - rttStart);
    console.error(formatIngestErrorLog(err.message, attempt));
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

// Defensive stringify for errorHistory entries (yt_session_end's lastErrors,
// below) — this is the poller's own error path, which must never itself
// throw. err.message is normally a string, but nothing guarantees it (a
// library could set a non-string/circular .message); String() never throws
// on those the way JSON.stringify would, but wrap anyway in case a custom
// toString() does. Capped separately from ERROR_HISTORY_MAX (entry count)
// so one pathological message can't blow out the log line.
const ERROR_HISTORY_ENTRY_MAX_LEN = 300;
function safeErrorText(value) {
  let s;
  try {
    s = typeof value === 'string' ? value : String(value);
  } catch {
    s = '[unstringifiable error]';
  }
  return s.length > ERROR_HISTORY_ENTRY_MAX_LEN ? s.slice(0, ERROR_HISTORY_ENTRY_MAX_LEN) : s;
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
  // Last N error messages that drove consecutiveErrors, surfaced on
  // yt_session_end below — audit round 2026-08-20 had to cross-reference
  // poller_heartbeat against Worker-side logs by hand to tell a quiet
  // end-of-broadcast from a genuine stall; this + classification puts that
  // evidence directly on the one log line that already marks the boundary.
  let errorHistory = [];
  const ERROR_HISTORY_MAX = 5;
  // armedAt is set from the 'start' event, not here — that's the moment this
  // session actually establishes, before any chat items can arrive (the
  // library's first poll tick fires `interval` ms later).
  let ephemeral = { armed: isReconnect, armedAt: null, recoveredCount: 0 };
  let lastErrorMsg = null; // last error seen this session — routes the reconnect cadence

  liveChat.on('start', (liveId) => {
    sessionGeneration++; // new session — any in-flight probe from the PREVIOUS one is now stale
    videoIdTracker.onStart(liveId); // youtube-chat resolves this itself — never a search.list call
    // ADD 3 (round-3 audit): the resolved videoId was never logged anywhere,
    // which is why the burst-5 investigation couldn't identify which video
    // the poller had been stuck on for 4 hours — this has now blocked two
    // rounds of investigation. One line per session (not per cycle), so it
    // stays bounded.
    console.log(JSON.stringify({ ev: 'yt_session_start', videoId: liveId || null }));
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
    cycleGlobalEmojiRenders += takeGlobalEmojiRenderCount();
    if (!msg) return;
    if (result.recovered) msg.recovered = true;
    post(msg);
  });

  liveChat.on('error', (err) => {
    lastErrorMsg = err?.message ?? String(err);
    console.error(`live chat error: ${lastErrorMsg}`);
    errorHistory.push(safeErrorText(lastErrorMsg));
    if (errorHistory.length > ERROR_HISTORY_MAX) errorHistory.shift();
    consecutiveErrors++;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`${consecutiveErrors} consecutive errors — forcing reconnect`);
      liveChat.stop('too many consecutive errors');
    }
  });

  liveChat.on('end', (reason) => {
    // ADD 3: capture the videoId before onEnd() clears it, and log the
    // actual `reason` stop() was called with (library passes it straight
    // through as the 'end' payload) rather than re-deriving it from
    // lastErrorMsg, which wouldn't carry a forced-stop reason like "zombie
    // watchdog: sustained fetched=0" or "too many consecutive errors".
    const endedVideoId = videoIdTracker.get();
    videoIdTracker.onEnd(); // session's gone — stop spending quota on an ended stream's stats
    liveChatSessionActive = false; // idle until the next 'start' — zombie watchdog must not count offline silence
    // classification is a best-effort read of the same liveness signal the
    // zombie-watchdog threshold selection already trusts (see
    // WATCHDOG_LIVENESS_GATE above) — 'not_live' at close time means YouTube
    // itself confirms nothing's live (quiet end-of-broadcast, the expected
    // MAX_CONSECUTIVE_ERRORS death path); 'live' means the close happened
    // while YouTube still says the stream is up (a genuine stall worth
    // investigating); 'unknown'/'gate_off' means the signal wasn't available
    // this cycle — not a claim either way. Applies the identical
    // livenessFresh/LIVENESS_MAX_AGE_MS guard the heartbeat interval uses for
    // this same lastLiveness variable (FIX 2 above) — a stale sample must
    // only ever read as 'unknown' here too, never a stale positive/negative.
    const livenessFreshAtEnd = Date.now() - lastLiveness.at <= LIVENESS_MAX_AGE_MS;
    const effectiveLivenessAtEnd = !WATCHDOG_LIVENESS_GATE
      ? 'gate_off'
      : livenessFreshAtEnd ? lastLiveness.state : 'unknown';
    const classification = effectiveLivenessAtEnd === 'not_live' ? 'stream_ended'
      : effectiveLivenessAtEnd === 'live' ? 'stall'
      : 'unknown';
    console.log(JSON.stringify({
      ev: 'yt_session_end',
      videoId: endedVideoId,
      reason: reason || null,
      lastErrors: errorHistory.slice(),
      classification,
    }));
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

// REFINEMENT 3: check-then-act for the not_live watchdog path. Fire-and-
// forget from the heartbeat tick (never awaited there) — the probe can take
// up to DEFAULT_PROBE_TIMEOUT_MS (8s), and blocking the 15s heartbeat cycle
// on it would risk running into the next tick; the probe's own outcome is
// logged independently whenever it actually resolves. Uses a throwaway
// LiveChat instance (rediscovery.mjs) — it emits ONLY its own 'start'/
// 'error' events, never touches videoIdTracker or currentLiveChat directly,
// and so can never itself produce a yt_session_start/yt_session_end line;
// those remain bound exclusively to the real session's own handlers in
// run(), above.
async function runRediscoveryProbe() {
  const gate = rediscoveryGate.tryStart();
  if (!gate.allowed) {
    console.log(JSON.stringify({ ev: 'yt_rediscovery', liveness: 'not_live', changed: false, outcome: `skipped_${gate.reason}` }));
    return;
  }
  try {
    const generationAtStart = sessionGeneration;
    const probedVideoId = await probeCurrentLiveId(LiveChat, YT_CHANNEL_ID);
    // Re-read AFTER the await, not a pre-probe snapshot — see
    // resolveRediscoveryOutcome's comment in rediscovery.mjs for why: the
    // real session can swap (end + new start) during this up-to-8s wait, and
    // a stale comparison would tear down the NEW, healthy session instead of
    // the one the probe actually started against.
    const heldVideoId = videoIdTracker.get();
    const outcome = resolveRediscoveryOutcome({
      generationAtStart,
      currentGeneration: sessionGeneration,
      heldVideoId,
      probedVideoId,
    });
    if (outcome.action === 'discarded') {
      console.log(JSON.stringify({ ev: 'yt_rediscovery', liveness: 'not_live', changed: false, discarded: true, probedVideoId: probedVideoId || null }));
      return;
    }
    if (outcome.action === 'no_session') {
      console.log(JSON.stringify({ ev: 'yt_rediscovery', liveness: 'not_live', changed: false, outcome: 'skipped_no_session', probedVideoId: probedVideoId || null }));
      return;
    }
    const changed = outcome.action === 'changed';
    console.log(JSON.stringify({ ev: 'yt_rediscovery', liveness: 'not_live', changed, probedVideoId: probedVideoId || null }));
    if (changed) {
      currentLiveChat?.stop('liveness rediscovery: videoId changed, sustained fetched=0');
    }
  } finally {
    gate.release();
  }
}

// Proves the poller container itself is alive, independent of whether a
// live chat session is currently attached — multichat's status chip uses this.
// Counts ride the same payload when a live session holds a current video id;
// fetchYtVideoState's counts field resolves to null (no fields added)
// whenever it doesn't, so a heartbeat during an offline stretch is
// byte-for-byte what it was before this feature existed. This interval is
// NOT live-gated — it runs on this same 15s cadence whether a stream is live
// or not, so silence in the poller_heartbeat log below always means the
// poller process itself died, never just "stream is offline".
setInterval(async () => {
  const videoId = videoIdTracker.get();
  // Change 1: single videos.list call feeds both the topbar counts (below,
  // unchanged output — see ADD 5 in the plan doc) and the watchdog's
  // liveness gate. Never call fetchYtCounts here too — that would spend a
  // second quota unit for data this call already carries.
  const videoState = await fetchYtVideoState(videoId, YOUTUBE_API_KEY);
  const counts = videoState.counts;
  lastLiveness = videoState.liveness;
  // Classified here, not inside fetchYtVideoState, so its heartbeat payload
  // contract (counts: null = zero fields, never a special case) stays
  // untouched — zero ingest surface change vs. before this feature existed.
  // skip = feature not configured/not live; err = key+videoId present but
  // the call still came back with no usable counts (quota death, revoked
  // key, malformed response) — previously indistinguishable from "not live"
  // and silent.
  const countsOutcome = (!YOUTUBE_API_KEY || !videoId) ? 'skip' : (counts ? 'ok' : 'err');
  const lastMessageAgeSec = lastChatAt ? Math.round((Date.now() - lastChatAt) / 1000) : null;

  // FIX 2 / Change 2: a stale sample is never trusted as a positive not_live
  // read — it can only make the watchdog MORE patient (route to 'unknown'),
  // never hold it off. FIX 3: the kill switch reports its own 'gate_off'
  // value distinct from 'unknown', so heartbeat consumers can tell "off on
  // purpose" from "couldn't classify this cycle".
  const livenessFresh = Date.now() - lastLiveness.at <= LIVENESS_MAX_AGE_MS;
  const liveness = !WATCHDOG_LIVENESS_GATE ? 'gate_off' : livenessFresh ? lastLiveness.state : 'unknown';

  // BLOCKING (round-3 audit): liveness SELECTS a threshold, it never
  // suppresses — see the constants block above for why. not_live gets the
  // cheap rediscovery cadence; live/unknown/gate_off all get the patient
  // backstop (gate_off uses the pre-audit legacy constant so the kill switch
  // is a true rollback).
  const watchdogThresholdMin = !WATCHDOG_LIVENESS_GATE
    ? LEGACY_ZOMBIE_WATCHDOG_MIN
    : liveness === 'not_live'
      ? REDISCOVERY_MIN
      : ZOMBIE_WATCHDOG_MIN;
  const watchdogThresholdCycles = !WATCHDOG_LIVENESS_GATE
    ? LEGACY_ZOMBIE_WATCHDOG_CYCLES
    : liveness === 'not_live'
      ? REDISCOVERY_CYCLES
      : ZOMBIE_WATCHDOG_CYCLES;

  const status = await post({
    type: 'heartbeat',
    unknownRenderers: { ...unknownRendererCounts },
    fetched: cycleFetched,
    lastMessageAgeSec,
    // ADD 4: additive only, no renames — makes the next audit answerable
    // from the heartbeat alone instead of a second YouTube API cross-check.
    liveness,
    watchdogThresholdMin,
    ...(counts || {}),
  });
  console.log(JSON.stringify({
    ev: 'poller_heartbeat',
    fetched: cycleFetched,
    posted: cyclePosted,
    failed: cycleFailed,
    status,
    counts: countsOutcome,
    liveness,
    watchdogThresholdMin,
    rtt_buckets: cycleRttBuckets,
    rtt_max_ms: Math.round(cycleRttMaxMs),
    rtt_count: cycleRttCount,
    globalEmojiRenders: cycleGlobalEmojiRenders,
  }));
  // forensics rec 4 + round-3 audit: empty-200 zombie watchdog, threshold
  // now liveness-selected (see constants block). Gated on
  // liveChatSessionActive — this heartbeat interval is deliberately NOT
  // live-gated (see comment above), so cycleFetched===0 is the normal,
  // permanent state whenever there's no stream at all; ungated, this would
  // force a "reconnect" on a fixed cadence all night, every night, with no
  // stream up.
  if (liveChatSessionActive) {
    if (cycleFetched === 0) {
      zeroStreak++;
      if (zeroStreak >= watchdogThresholdCycles) {
        zeroStreak = 0; // avoid re-checking every tick — see rediscoveryGate below for the independent, authoritative spacing guarantee
        // REFINEMENT 1: not_live rediscovery is expected, near-zero-cost in
        // the common case, not a health problem — it gets its own event so
        // it never pollutes zombie_watchdog_reconnect, which stays reserved
        // for "something might actually be wrong".
        if (WATCHDOG_LIVENESS_GATE && liveness === 'not_live') {
          // fire-and-forget: logs its own outcome, tears down currentLiveChat
          // itself only if the videoId genuinely changed. runRediscoveryProbe
          // is not expected to ever reject (probeCurrentLiveId never does),
          // but this must never surface as an unhandled rejection regardless.
          runRediscoveryProbe().catch((err) => console.error(`rediscovery probe failed: ${err.message}`));
        } else {
          console.log(JSON.stringify({ ev: 'zombie_watchdog_reconnect', zeroStreakMin: watchdogThresholdMin, liveness }));
          currentLiveChat?.stop('zombie watchdog: sustained fetched=0');
        }
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
  cycleGlobalEmojiRenders = 0;
}, HEARTBEAT_INTERVAL_MS);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

run();
