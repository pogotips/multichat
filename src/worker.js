// Plain-value constants (PENDING_MOD_TTL_MS/MAX, VALID_KINDS, TTS_LABELS,
// EMIT_TTL_MS) live in lib.js, not here — this is the Worker's entry module,
// and workerd rejects a non-function/class top-level named export from an
// entry module (see lib.js's own header comment for the full why). Every
// `export function`/`export class` below this line is fine as-is.
import {
  PENDING_MOD_TTL_MS, PENDING_MOD_MAX, VALID_KINDS, TTS_LABELS, EMIT_TTL_MS, FINANCIAL_KINDS,
  GIGANTIFY_SUPPRESS_WINDOW_MS,
  beginFetchSpan, endFetchSpan, snapshotOpenSpans, spannedFetch, cleanSpokenName,
  EMOTE_ID_RE, ALLOWED_EMOJI_HOST_RE, isAllowedEmojiUrl, ALLOWED_GIF_HOST_RE, isAllowedGifUrl,
  renderGifToken, mergeAnnotations, appendWithMention, renderText, buildRow,
  OVERLAY_PARAM_SPEC, OVERLAY_FONT_STACKS, validateOverlayConfig,
  sanitizeSpokenBody, markMatchesQueueItem, normalizeSpokenMentions, stripControlChars, stripUrls,
} from './lib.js';
import { ICON_180_B64, ICON_192_B64, ICON_512_B64, FAVICON_32_B64 } from './assets.js';

const RELEASE_VERSION = '2026.09.03.4'; // CalVer, human-facing

// ── OBS overlay: server TTS (Workers AI) ────────────────────────────────────
// Model + speaker as single-source constants (per Jon's ask) — verified live
// against developers.cloudflare.com/workers-ai/models/aura-2-en/ during
// Phase 0 recon: $0.03/1k chars, 40-voice enum, binding returns a
// ReadableStream of MPEG audio. Switching to @cf/deepgram/aura-1 (cheaper,
// 12 voices) is a one-line change here, not a refactor.
const TTS_MODEL = '@cf/deepgram/aura-2-en';
const TTS_SPEAKER = 'luna';
const TTS_TEXT_MAX = 200;        // whole-utterance hard cap, server-side, independent of the client's own body cap
const TTS_MINUTE_LIMIT = 20;     // calls/min — the guard that actually bites (200 chars x 20/min exhausts the free daily Workers AI allocation in under a minute)
const TTS_DAILY_CHAR_BUDGET = 25_000; // stop-loss, ~20x a heavy stream's real usage (~1,200 chars) — caps a runaway at ~$0.75/day on aura-2-en
const TTS_KILL_STORAGE_KEY = 'ttsKill';
const TTS_DAILY_STORAGE_KEY = 'ttsDaily';

const ENC = new TextEncoder(); // module-level memo — avoid a throwaway TextEncoder per call on hot paths

const RING_SIZE = 200;
const WATCHDOG_MS = 60_000;        // recheck socket health while clients attached
const IDLE_DISCONNECT_MS = 120_000; // drop IRC ~2 min after last client leaves
const HEARTBEAT_MS = 25_000;        // SSE ping event, keeps proxies/iOS from closing idle conns
const MAX_BACKOFF_MS = 30_000;
const IRC_SILENCE_MS = 6 * 60_000;  // force-reconnect if the Twitch socket goes quiet this long
const IRC_KEEPALIVE_MS = 60_000;    // client-initiated PING cadence — see startIrcKeepalive
const IRC_RECYCLE_MS = 30 * 60_000; // clean-close + reconnect the Twitch socket this often — bounds DO console.log flush latency (see ARCHITECTURE.md)
const TWITCH_HELIX_POLL_MS = 15_000;    // Get Streams poll cadence, only while SSE clients attached
const TW_VIEWERS_STALE_MS = 2 * TWITCH_HELIX_POLL_MS;  // 2 missed polls = stale
const YT_COUNTS_STALE_MS = 30_000;      // 2x the yt-poller's 15s heartbeat cadence
const TW_FOLLOWERS_POLL_MS = 5 * 60_000; // followers don't move fast; 5min is plenty
const TW_FOLLOWERS_STALE_MS = 2 * TW_FOLLOWERS_POLL_MS;
const TW_USER_REFRESH_TOKEN_KEY = 'twUserRefreshToken'; // ctx.storage key — see getTwitchUserToken
const RECOVER_TIMEOUT_MS = 3000;         // recent-messages fetch: hard cap, must never delay reconnect
const RECOVER_MAX_AGE_MS = 10 * 60_000;  // gap-recovery window cap
const TWITCH_API_TIMEOUT_MS = 10_000;    // app-token + Helix streams-discovery fetches: hard cap, never block chat — matches the poller's sendOnce convention (poller.mjs)
const CAPTURE_FLUSH_LINES = 50;   // mid-session burst trigger — fire-and-forget
const CAPTURE_MAX_BUFFER = 500;   // hard cap: a stuck/failing R2 can never OOM the DO
const INGEST_MAX_BYTES = 16 * 1024; // generous for one chat event; rejects runaway/compromised poller bodies
const CLIENT_ERROR_MAX_BYTES = 2 * 1024; // forensics rec 5: a short message/stack, not a chat payload
const CLIENT_ERROR_FIELD_MAX = 500; // per-field clamp — one oversized field can't blow past the body cap via padding elsewhere
const REAP_STRIKE_LIMIT = 3;      // consecutive negative-desiredSize heartbeats before evicting a dead SSE reader
const MAX_SSE_AGE_MS = 6 * 60 * 60_000; // force-close SSE streams older than this; client auto-reconnects (no gap)

// The yt-poller's retry queue dispatches up to SEND_CONCURRENCY (4) POSTs at
// once (see tools/yt-poller/retry-queue.mjs) — FIFO is only preserved across
// failure-requeues, not across a concurrently-in-flight batch, so a mod
// delete/author_delete can reach this DO before the chat message it targets.
// pendingYtDeletes/pendingAuthorDeletes buffer that race instead of letting
// markDeletedYt no-op it away; pushMessage checks both on every yt insert.

// Twitch EventSub webhook — channel-point redemptions, hype train, ad break.
// Raids are deliberately NOT subscribed here: IRC USERNOTICE already renders
// them in-band (see parseUsernotice's sys:'raid' branch below). Standing
// rule: EventSub subscribes only to what IRC cannot see.
const EVENTSUB_MAX_BYTES = 64 * 1024;          // cap body size before any HMAC work
const EVENTSUB_STALE_MS = 10 * 60_000;         // reject notifications older than 10 min (Twitch's own guidance)
const EVENTSUB_ID_MAX = 500;                   // bounded dedupe set for at-least-once retries
const EVENTSUB_PENDING_GRACE_MS = 10 * 60_000; // webhook_callback_verification_pending grace before treated as dead
const EVENTSUB_ENSURE_INTERVAL_MS = 24 * 60 * 60_000; // re-check cadence once every desired sub is healthy
const EVENTSUB_ENSURE_RETRY_MS = 60 * 60_000;          // faster re-check cadence while anything is unhealthy (e.g. secret not yet set)
const REWARD_TITLE_MAX = 64;   // ellipsize cap — viewer-controlled text never enters the ring uncapped
const USER_INPUT_MAX = 200;    // same, for the redemption's free-text user_input
const MODE_CHANGE_TEXT_MAX = 200; // same, for the YT liveChatModeChangeMessageRenderer text

// ── Worker entry ─────────────────────────────────────────────────────────

const ROUTES = [
  ['GET', /^\/$/, handleIndex],
  ['GET', /^\/events$/, handleEvents],
  ['POST', /^\/ingest\/yt$/, handleIngestYt],
  ['POST', /^\/client-error$/, handleClientError],
  ['POST', /^\/eventsub\/callback$/, handleEventSubCallback],
  ['GET', /^\/overlay$/, handleOverlay],
  ['GET', /^\/overlay\/config$/, handleOverlayConfig],
  ['POST', /^\/overlay\/admin$/, handleOverlayAdmin],
  ['POST', /^\/tts$/, handleTts],
  ['GET', /^\/api\/version$/, handleVersion],
  ['GET', /^\/manifest\.webmanifest$/, handleManifest],
  ['GET', /^\/icon-180\.png$/, () => handleIcon(ICON_180_BYTES ??= iconBytes(ICON_180_B64))],
  ['GET', /^\/icon-192\.png$/, () => handleIcon(ICON_192_BYTES ??= iconBytes(ICON_192_B64))],
  ['GET', /^\/icon-512\.png$/, () => handleIcon(ICON_512_BYTES ??= iconBytes(ICON_512_B64))],
  // Unauthenticated like the PWA icons above — a favicon request never
  // carries the ?t= token, and browsers fetch it unprompted for every page
  // (PWA, /overlay, /overlay/config alike), so it must never touch the DO.
  // PNG bytes at a .ico path: every browser that requests /favicon.ico
  // accepts image/png there, no real .ico container needed.
  ['GET', /^\/favicon\.ico$/, handleFavicon],
];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    for (const [method, pattern, handler] of ROUTES) {
      if (req.method === method && pattern.test(url.pathname)) {
        return handler(req, env, ctx, url);
      }
    }
    return new Response('Not found', { status: 404 });
  },
};

function handleIndex(req, env) {
  return new Response(pageHtml((env.MULTICHAT_MY_NAME || '').toLowerCase()), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// no-store so a param edit takes effect on a plain refresh — an OBS browser
// source reload should never need a cache-bust. Unauthenticated — the page
// itself carries no chat data; /events and /tts (both still gated) are what
// actually need the secret, and this page just forwards whatever `t` it was
// given to them (see requireEventsToken / requireOverlayToken below).
function handleOverlay(req, env, ctx, url) {
  const { config, rejections } = validateOverlayConfig(url.searchParams);
  for (const r of rejections) {
    console.log(JSON.stringify({ ev: 'overlay_param_reject', key: r.key, raw: r.raw }));
  }
  const token = url.searchParams.get('t');
  const myName = (env.MULTICHAT_MY_NAME || '').toLowerCase();
  return new Response(overlayHtml(config, myName, token), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Separate page, opened in a real browser, never added to an OBS scene.
// Still gated by the overlay secret (unlike /overlay itself, which dropped
// this) — this page's whole job is to hand back a finished /overlay URL.
function handleOverlayConfig(req, env, ctx, url) {
  const denied = requireOverlayToken(url, env);
  if (denied) return denied;
  const token = url.searchParams.get('t');
  return new Response(overlayConfigHtml(token), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function handleVersion() {
  // no-store: the pull-to-refresh reload gate compares this against the
  // client's embedded BUILD_VERSION — a heuristically cached response would
  // skew that comparison by one pull after a deploy.
  return Response.json({ releaseVersion: RELEASE_VERSION }, { headers: { 'cache-control': 'no-store' } });
}

const MANIFEST_JSON = JSON.stringify({
  name: 'Multichat',
  short_name: 'Multichat',
  display: 'standalone',
  background_color: '#0b0b0f',
  theme_color: '#0b0b0f',
  start_url: '/',
  scope: '/',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

function handleManifest() {
  return new Response(MANIFEST_JSON, {
    headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' },
  });
}

// Icons are served immutable/max-age=1y, but the base64 decode itself ran
// per-request — each cold hit re-decoded 18-61KB char-by-char. The
// ROUTES-level ??= memoizes the decoded bytes lazily on first hit per isolate.
let ICON_180_BYTES, ICON_192_BYTES, ICON_512_BYTES, FAVICON_32_BYTES;

function iconBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function handleIcon(bytes) {
  return new Response(bytes, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' },
  });
}

// Shorter TTL than the PWA icons above (86400s = 1 day, not immutable) —
// the browser-default /favicon.ico request happens on far more surfaces
// (every tab, bookmark, history entry) than the PWA icons ever get fetched
// from, so a bad favicon push shouldn't need a year to age out everywhere.
function handleFavicon() {
  return new Response(FAVICON_32_BYTES ??= iconBytes(FAVICON_32_B64), {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
  });
}

// Edge auth gate — validate before touching the DO stub (DO duration is billed cost).
async function handleEvents(req, env, ctx, url) {
  const denied = requireEventsToken(url, env);
  if (denied) return denied;
  const stub = env.HUB.getByName('main');
  // Threaded through so the DO can derive its own public EventSub callback
  // URL (`${origin}/eventsub/callback`) without a new wrangler.jsonc var —
  // see ensureEventSubSubscriptions. Skipped entirely on non-https origins
  // (local `wrangler dev`) since no public callback is reachable there.
  const headers = { 'x-multichat-origin': url.origin };
  // Native EventSource sets Last-Event-ID itself on auto-reconnect, but a
  // manually-recreated EventSource (fatal-error / background recovery paths)
  // can't set headers — the client passes the same id via query string instead.
  const lastEventId = req.headers.get('Last-Event-ID') || url.searchParams.get('lastEventId');
  if (lastEventId && Number.isFinite(Number(lastEventId))) headers['Last-Event-ID'] = lastEventId;
  return stub.fetch('https://do/events', { headers });
}

async function handleIngestYt(req, env, ctx, url) {
  const secret = req.headers.get('X-Multichat-Secret');
  // Two valid callers, two independent secrets: the yt-poller host and
  // an optional external renewal cron. Neither should be able to impersonate
  // the other, but both write to the same feed, so either secret admits here.
  // caller is threaded to the DO so it can scope capabilities per-secret —
  // see the {type:'mod'} caller check below: the raid-queue cron secret must
  // never gain chat-moderation capability (marking rows deleted) just because
  // it shares this route with the poller's chat-ingest traffic.
  const isPoller = safeEqual(secret, env.MULTICHAT_INGEST_SECRET);
  const isRaidq = !isPoller && safeEqual(secret, env.MULTICHAT_RAIDQ_INGEST_SECRET);
  if (!isPoller && !isRaidq) {
    return new Response('unauthorized', { status: 401 });
  }
  const contentLength = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > INGEST_MAX_BYTES) {
    return new Response('payload too large', { status: 413 });
  }
  const bodyText = await req.text();
  if (ENC.encode(bodyText).length > INGEST_MAX_BYTES) {
    return new Response('payload too large', { status: 413 });
  }
  const stub = env.HUB.getByName('main');
  const headers = { 'content-type': 'application/json', 'x-multichat-caller': isPoller ? 'poller' : 'raidq' };
  // Forwarded verbatim for the ingest-tail correlation — the poller's own clock is the join key
  // between its RTT measurement and the DO's in-handler ingest_timing log.
  // Absent header is fine: ChatHub.handleIngestYt defaults to "none".
  const reqId = req.headers.get('X-Req-Id');
  if (reqId) headers['X-Req-Id'] = reqId;
  return stub.fetch('https://do/ingest/yt', {
    method: 'POST',
    headers,
    body: bodyText,
  });
}

// forensics rec 5: minimal client-side error beacon. This investigation hit a
// hard wall trying to explain a reported red YT chip — nothing server-side
// could have produced it, and there was no way to see what the client
// actually did (no error reporting existed). Gated on the same view token
// `/events` already uses — not an open endpoint — which caps spam exposure to
// "already has a valid viewer link" (same trust tier as the page itself) and
// needs no new secret or endpoint-specific rate limiter. No DO involved: this
// is stateless logging, validated and console.log'd directly at the edge.
async function handleClientError(req, env, ctx, url) {
  const denied = requireViewToken(url, env);
  if (denied) return denied;
  const contentLength = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > CLIENT_ERROR_MAX_BYTES) {
    return new Response('payload too large', { status: 413 });
  }
  const bodyText = await req.text();
  if (ENC.encode(bodyText).length > CLIENT_ERROR_MAX_BYTES) {
    return new Response('payload too large', { status: 413 });
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return new Response('missing message', { status: 400 });
  }
  const clampStr = (v) => (typeof v === 'string' ? v.slice(0, CLIENT_ERROR_FIELD_MAX) : undefined);
  // Per-field clamp on top of the body-size cap, so one oversized field can't
  // blow past it via padding elsewhere, and pulled from the JSON body only —
  // never req.url/the query string — so the token itself never reaches the log.
  console.log(JSON.stringify({
    ev: 'client_error',
    message: clampStr(body.message),
    source: clampStr(body.source),
    line: Number.isFinite(body.line) ? body.line : undefined,
    col: Number.isFinite(body.col) ? body.col : undefined,
    stack: clampStr(body.stack),
    ts: Number.isFinite(body.ts) ? body.ts : undefined,
  }));
  return new Response('ok', { status: 200 });
}

const TTS_MAX_BYTES = 2048; // generous for a short JSON {text} body — this is a real-money endpoint, treat as abusable

// Real-money endpoint (Workers AI, $0.03/1k chars on the default model) —
// every failure mode here fails SILENT to the caller (204, no error body)
// and LOUD to the operator (one ev log line), per Jon's explicit ask: a
// viewer/OBS source should never see a TTS error, but silent throttling
// reading as "TTS is broken" mid-stream is worse than a log line. The DO
// gate (handleTtsAllow) does the actual kill/minute/budget accounting — this
// function's own job is auth, text hardening, and the actual env.AI.run
// call + streaming, which per B1 must happen HERE in the Worker, never in
// the single-threaded ChatHub DO (see handleTtsAllow's own comment).
async function handleTts(req, env, ctx, url) {
  const denied = requireOverlayToken(url, env);
  if (denied) return denied;
  const contentLength = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > TTS_MAX_BYTES) {
    return new Response(null, { status: 204 });
  }
  let body;
  try {
    const bodyText = await req.text();
    if (ENC.encode(bodyText).length > TTS_MAX_BYTES) return new Response(null, { status: 204 });
    body = JSON.parse(bodyText);
  } catch {
    console.log(JSON.stringify({ ev: 'tts_bad_request' }));
    return new Response(null, { status: 204 });
  }
  const rawText = typeof body.text === 'string' ? body.text : '';
  // Server-side hardening, independent of whatever the client sent — strip
  // control chars and URLs, then hard-cap at TTS_TEXT_MAX. Deliberately
  // simpler than the client's own sanitizeSpokenBody (no repeat-collapse, no
  // mention-normalize) — this is the endpoint's own last-line defense
  // against a direct call that bypasses the overlay client entirely, not a
  // duplicate of the client's readability pipeline.
  let text = stripControlChars(rawText);
  text = stripUrls(text);
  text = text.trim().slice(0, TTS_TEXT_MAX);
  if (!text) {
    console.log(JSON.stringify({ ev: 'tts_empty_text' }));
    return new Response(null, { status: 204 });
  }

  const stub = env.HUB.getByName('main');
  let verdict;
  try {
    const allowRes = await stub.fetch('https://do/tts-allow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chars: text.length }),
    });
    verdict = await allowRes.json();
  } catch (err) {
    console.log(JSON.stringify({ ev: 'tts_gate_error', message: err && err.message }));
    return new Response(null, { status: 204 });
  }
  if (!verdict.ok) {
    // Already logged inside the DO (tts_killed/tts_throttled/tts_budget_exhausted).
    return new Response(null, { status: 204 });
  }

  if (!env.AI) {
    console.log(JSON.stringify({ ev: 'tts_no_ai_binding' }));
    return new Response(null, { status: 204 });
  }
  try {
    return await env.AI.run(TTS_MODEL, { text, speaker: TTS_SPEAKER }, { returnRawResponse: true });
  } catch (err) {
    console.log(JSON.stringify({ ev: 'tts_generate_error', message: err && err.message }));
    return new Response(null, { status: 204 });
  }
}

// Admin path for the TTS kill-switch — gated on requireOverlayToken /
// MULTICHAT_OVERLAY_SECRET, restored 2026-08-27 after a brief unauthenticated
// window (Jon's call to walk it back: the separate MULTICHAT_ADMIN_SECRET
// stays retired — one secret, not a fourth — but the route itself needs a
// gate). Same secret /tts and /overlay/config already check; not a new
// value, just reused here too. Only op supported is tts_kill.
async function handleOverlayAdmin(req, env, ctx, url) {
  const denied = requireOverlayToken(url, env);
  if (denied) return denied;
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const stub = env.HUB.getByName('main');
  return stub.fetch('https://do/tts-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// First public unauthenticated route in this Worker — the only "auth" is
// Twitch's HMAC signature over the raw body, verified here at the edge
// before the DO is ever touched (DO duration is billed cost, same reasoning
// as handleEvents' secret gate). Fail-closed at every step: any missing
// header, bad signature, stale timestamp, or unparseable body returns 403,
// never a thrown 500.
//
// SIGNED-TRUTH RULE: Twitch's HMAC covers only `id + timestamp + rawBody` —
// it does NOT cover any header. So `subscription.type`/`version`, wherever
// used for routing or event-mapping, is read from the *parsed body's*
// `subscription` object (covered by the signature), never from a header —
// even one we forward ourselves. A forwarded x-es-id header is fine (it's
// just the already-verified message-id, used only as a dedupe key, never
// for routing), but no x-es-type/x-es-sub-type header is ever sent.
export async function handleEventSubCallback(req, env, ctx) {
  const contentLength = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > EVENTSUB_MAX_BYTES) {
    return new Response('payload too large', { status: 413 });
  }
  const rawBody = await req.text();
  if (ENC.encode(rawBody).length > EVENTSUB_MAX_BYTES) {
    return new Response('payload too large', { status: 413 });
  }
  const id = req.headers.get('twitch-eventsub-message-id');
  const timestamp = req.headers.get('twitch-eventsub-message-timestamp');
  const signature = req.headers.get('twitch-eventsub-message-signature');
  const messageType = req.headers.get('twitch-eventsub-message-type');
  if (!id || !timestamp || !signature || !messageType) {
    return new Response('missing headers', { status: 403 });
  }
  if (!env.EVENTSUB_SECRET) {
    // Unset secret means we structurally cannot verify — degrade to
    // disabled rather than ever accept an unverified notification.
    console.error(JSON.stringify({ ev: 'eventsub_no_secret' }));
    return new Response('forbidden', { status: 403 });
  }
  const validSig = await verifySignature(env.EVENTSUB_SECRET, id, timestamp, rawBody, signature);
  if (!validSig) {
    // Loud, at the EDGE, immediate flush — the DO's own console.log only
    // flushes when its Twitch IRC socket closes (see ChatHub.startIrcRecycle),
    // which must never sit between us and "someone just sent a forged
    // request" or "our secret and Twitch's have drifted".
    console.error(JSON.stringify({ ev: 'eventsub_bad_signature', id, messageType }));
    return new Response('forbidden', { status: 403 });
  }
  if (isStale(timestamp, Date.now(), EVENTSUB_STALE_MS)) {
    console.error(JSON.stringify({ ev: 'eventsub_stale', id, messageType }));
    return new Response('stale', { status: 403 });
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Signature passed but the body isn't JSON — fail closed, never throw.
    console.error(JSON.stringify({ ev: 'eventsub_bad_json', id, messageType }));
    return new Response('bad json', { status: 403 });
  }
  if (messageType === 'webhook_callback_verification') {
    // Handled entirely at the edge — no DO — because the challenge must be
    // answered even while the DO is cold/evicted.
    const challenge = body && typeof body.challenge === 'string' ? body.challenge : '';
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (messageType === 'revocation') {
    const subType = body?.subscription?.type;
    const status = body?.subscription?.status;
    console.error(JSON.stringify({ ev: 'eventsub_revoked', id, subType, status }));
    // Ping the DO so it fast-tracks its next reconcile instead of waiting out
    // the daily cadence a previously-healthy esAllHealthy state earned — see
    // ChatHub.handleEventSubRevoked. No body needed; the subsequent
    // ensureEventSubSubscriptions pass rediscovers the dead sub itself.
    const stub = env.HUB.getByName('main');
    ctx.waitUntil(stub.fetch('https://do/eventsub-revoked', { method: 'POST' }));
    return new Response(null, { status: 204 });
  }
  if (messageType === 'notification') {
    const stub = env.HUB.getByName('main');
    // x-es-id and x-es-ts are forwarded because neither is recoverable from
    // the body itself (both are HMAC-covered inputs to verifySignature above,
    // same as a redemption's userInput isn't recoverable from anywhere else)
    // — never a type/sub-type header, since the DO reads subscription.type
    // from this same verified body instead. x-es-ts backs
    // ChatHub.handleGigantifyDedupe's candidate-timestamp comparison.
    ctx.waitUntil(stub.fetch('https://do/eventsub', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-es-id': id, 'x-es-ts': timestamp },
      body: rawBody,
    }));
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 204 }); // unknown message type — ack, ignore
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = ENC.encode(a);
  const bufB = ENC.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

// Shared ?t= viewer gate — was duplicated inline at handleEvents and
// handleClientError (two copies drifting is how one ends up half-enforced,
// per the OBS-overlay Phase 0 recon). Returns a 401 Response to short-circuit
// on, or null to continue. Every MULTICHAT_VIEW_SECRET-gated route calls this
// now instead of re-inlining the check.
function requireViewToken(url, env) {
  const secret = url.searchParams.get('t');
  if (!safeEqual(secret, env.MULTICHAT_VIEW_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }
  return null;
}

// Overlay/TTS gate — MULTICHAT_OVERLAY_SECRET ONLY, no MULTICHAT_VIEW_SECRET
// fallback (R1: the OBS scene URL leaks through screen shares and scene-
// collection exports, so it must be independently rotatable without kicking
// the phone-bookmarked /events viewer link). /overlay/config's own page
// load, /tts (the billed endpoint), and /overlay/admin (the kill switch,
// gate restored 2026-08-27) all gate on this — one secret, deliberately not
// a separate MULTICHAT_ADMIN_SECRET (retired, no longer checked anywhere).
// /overlay itself does NOT gate on this (Jon's call) — it embeds whatever
// `t` it was given for the client to use against /events/`/tts` itself.
function requireOverlayToken(url, env) {
  const secret = url.searchParams.get('t');
  if (!safeEqual(secret, env.MULTICHAT_OVERLAY_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }
  return null;
}

// /events is the one exception to R1's overlay-secret-only rule: the
// overlay's own EventSource needs to reach the SAME feed the PWA does, and
// there is no separate broadcast path to build one for. This widens /events
// itself to accept EITHER secret (mirroring handleIngestYt's existing
// two-secret accept for the poller vs raidq cron) — it does NOT relax /tts,
// /overlay/config, or /overlay/admin, all still requireOverlayToken-only.
function requireEventsToken(url, env) {
  const secret = url.searchParams.get('t');
  if (safeEqual(secret, env.MULTICHAT_VIEW_SECRET)) return null;
  if (safeEqual(secret, env.MULTICHAT_OVERLAY_SECRET)) return null;
  return new Response('unauthorized', { status: 401 });
}

// ── Durable Object ───────────────────────────────────────────────────────
// In-memory-only state (ring buffer + id counter). No storage restore on
// construction: if the DO evicts, attached clients just pick up live
// messages going forward — replay only needs to survive client reconnects
// within a single DO lifetime, not DO eviction.
export class ChatHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ring = [];
    this.nextId = Date.now(); // monotonic across restarts: a stale Last-Event-ID can never exceed a fresh id
    this.clients = new Set();
    this.socket = null;
    this.socketOpen = false;
    this.connecting = false;
    this.reconnectDelay = 1000;
    this.heartbeatTimer = null;
    this.ircKeepaliveTimer = null; // client-initiated Twitch PING cadence — see startIrcKeepalive
    this.ircKeepaliveSeq = 0;      // per-connection PING payload counter, reset on each new socket
    this.ircRecycleTimer = null;   // scheduled clean-close of the current socket — see startIrcRecycle
    this.twViewerPollTimer = null; // Helix "Get Streams" poll, only while SSE clients attached
    this.twToken = null;           // cached Twitch app access token (client-credentials)
    this.twTokenExp = 0;           // ms epoch; refresh a bit before this
    this.twViewers = null;         // last known Twitch viewer count (null = never seen / offline)
    this.twViewersAt = 0;          // ms epoch of that last successful poll
    this.twFollowerPollTimer = null; // Helix "Get Channel Followers" poll, same lifecycle as viewer poll
    this.twUserToken = null;         // cached Twitch user access token (moderator:read:followers)
    this.twUserTokenExp = 0;         // ms epoch; refresh a bit before this
    this.twFollowers = null;         // last known follower total
    this.twFollowersAt = 0;          // ms epoch of that last successful poll
    this._twViewersLastError = null;   // last logged pollTwitchViewers error message (null = currently healthy)
    this._twFollowersLastError = null; // last logged pollTwitchFollowers error message (null = currently healthy)
    this.ytViewers = null;         // last known YouTube concurrent viewers, from poller heartbeat
    this.ytLikes = null;           // last known YouTube like count, from poller heartbeat
    this.ytCountsAt = 0;           // ms epoch of the last heartbeat that carried either field
    this.lastSeen = { tw: 0, yt: 0 }; // last inbound activity per platform, for status chips + IRC watchdog
    this.hasConnectedOnce = false;    // gap recovery only fires on reconnect, not first connect
    this.lastTwTmiSentTs = 0;         // dedupe cutoff for gap recovery (Twitch's own tmi-sent-ts, not our ts)
    this.recentTwitchIds = new Set(); // secondary dedupe guard, bounded to RING_SIZE, insertion order = FIFO
    this.recentYtIds = new Set();     // dedupe guard for yt-poller reconnect recovery, bounded to RING_SIZE
    this.pendingYtDeletes = new Map();     // ytId -> ts, mod deletes that raced ahead of their target message
    this.pendingAuthorDeletes = new Map(); // authorId -> ts, same race for author_delete
    this.pendingGigantifies = [];          // [{login, emoteName, emoteId, ts}], EventSub-first gigantify golds awaiting their PRIVMSG — see handleGigantifyDedupe/consumePendingGigantify, GIGANTIFY_SUPPRESS_WINDOW_MS
    this.roomStateInit = false;       // true once the post-(re)connect full ROOMSTATE burst has been swallowed
    this.captureBuf = [];             // unclassified IRC lines pending flush to R2 — exhaust, not archive
    this.connId = null;               // current Twitch socket's per-connection log id
    this.clientMeta = new Map();      // controller → { sseId, openedAt, strikes } for logging + zombie reaping
    this.recentEventSubIds = new Set(); // EventSub message-id dedupe, bounded — see handleEventSub
    this.hypeLevel = 0;                 // last-rendered Hype Train level; progress only renders on a level-up
    this.esOrigin = null;               // public https origin, threaded from the edge — see handleEvents
    this.esEnsured = false;             // true once ensureEventSubSubscriptions has run at least once
    this.esScopeChecked = false;        // true once logEventSubScopeCheck has run (once per DO lifetime)
    this.esScopeCheckResult = null;     // { hasBitsRead, hasAllEventSubScopes, checkedAt } from the last successful scope check, or null if none has succeeded — feeds createEventSubSubscription's 403-cause diagnosis (see logEventSubScopeCheck)
    this.esLastEnsured = 0;             // ms epoch of the last ensure run
    this.esAllHealthy = false;          // true iff every desired sub was already enabled+correct-version at the last ensure — gates hourly vs daily recheck
    this.esModerateHealthy = false;     // true iff channel.moderate is enabled+correct-version — decides row ownership (see applyClearchat/applyClearmsg); persisted (ctx.storage key 'esModerateHealthy') so a DO cold start doesn't forget a healthy sub and double-render. Hydrated below, blocking fetch() until it resolves.
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get('esModerateHealthy');
      this.esModerateHealthy = stored ?? false; // default false only when no reconcile has ever persisted a value (first boot / pre-feature DOs)
    });
    // Ingest-tail delay accumulators — running
    // totals since this DO instance started, read by the alarm()-cadence
    // rollup (Phase 4). Never reset mid-lifetime: the point is one line that
    // answers "how much total delay across the whole stream" without me
    // doing arithmetic across many log lines.
    this.delayTotalMs = 0;
    this.delayOver1s = 0;
    this.delayOver5s = 0;
    this.delayOver10s = 0;
    this.delayAttributedMs = 0;
    this.delayUnattributedMs = 0;
    this._delayLastRolledUp = null;  // last {totalMs,...} snapshot logged — change-gate for the rollup line
    this._delayRollupErrored = false; // error-once flag, same shape as _twViewersLastError et al.
    this.ttsMinuteWindow = null; // epoch-minute number, in-memory only — see handleTtsAllow
    this.ttsMinuteCount = 0;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/events' && req.method === 'GET') return this.handleEvents(req);
    if (url.pathname === '/ingest/yt' && req.method === 'POST') return this.handleIngestYt(req);
    if (url.pathname === '/eventsub' && req.method === 'POST') return this.handleEventSub(req);
    if (url.pathname === '/eventsub-revoked' && req.method === 'POST') return this.handleEventSubRevoked();
    if (url.pathname === '/tts-allow' && req.method === 'POST') return this.handleTtsAllow(req);
    if (url.pathname === '/tts-admin' && req.method === 'POST') return this.handleTtsAdmin(req);
    return new Response('Not found', { status: 404 });
  }

  handleEvents(req) {
    const lastEventId = req.headers.get('Last-Event-ID');
    const origin = req.headers.get('x-multichat-origin');
    if (origin) this.esOrigin = origin;
    const self = this;
    let controllerRef;
    const sseId = crypto.randomUUID().slice(0, 8);
    const openedAt = Date.now();
    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
        self.clients.add(controller);
        self.clientMeta.set(controller, { sseId, openedAt, strikes: 0 });
        self.ensureTwitchConnected();
        self.startHeartbeat();
        self.scheduleWatchdog();
        console.log(JSON.stringify({ ev: 'sse_open', sseId, hadLastEventId: Boolean(lastEventId) }));
        self.sendEventTo(controller, 'status', self.buildStatusPayload());
        if (lastEventId) {
          const lastId = Number(lastEventId);
          if (Number.isFinite(lastId)) {
            let matched = 0, sentFrom = null, sentTo = null;
            for (const msg of self.ring) {
              if (msg.id > lastId) {
                self.sendToController(controller, msg);
                matched++;
                if (sentFrom === null) sentFrom = msg.id;
                sentTo = msg.id;
              }
            }
            // Root-causes the "no backfill" class of report: what a replay
            // was asked for vs. what the ring actually had to give it.
            console.log(JSON.stringify({ ev: 'sse_replay_result', sseId, lastId, matched, sentFrom, sentTo }));
          }
        }
      },
      cancel() {
        self.dropClient(controllerRef, 'cancel');
        if (self.clients.size === 0) {
          self.stopHeartbeat();
          self.scheduleIdleDisconnect();
        }
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
      },
    });
  }

  async handleIngestYt(req) {
    // Ingest-tail correlation (Phase 2): snapshot
    // whatever outbound-fetch spans are open right now, then again once we
    // resume from the only await below — a slow outbound fetch elsewhere in
    // the DO that's overlapping THIS request's window is exactly what the
    // input-gate hypothesis predicts would delay it.
    const startedAt = Date.now();
    const reqId = req.headers.get('X-Req-Id') || 'none';
    const seenSpans = new Map();
    snapshotOpenSpans(seenSpans);
    try {
      let body;
      try {
        body = await req.json();
      } catch {
        return new Response('bad json', { status: 400 });
      }
      snapshotOpenSpans(seenSpans);
      if (body && body.type === 'heartbeat') {
        this.lastSeen.yt = Date.now();
        // forensics rec 4: unconditional, every heartbeat — this is health
        // telemetry (poller-side fetch activity), not a gated "did it change"
        // update like the viewer/like counts_update lines below. Distinct ev
        // name so CF Observability can watch poller fetch health without
        // conflating it with the counts feature.
        console.log(JSON.stringify({
          ev: 'yt_poller_health',
          fetched: Number.isFinite(body.fetched) ? body.fetched : null,
          lastMessageAgeSec: Number.isFinite(body.lastMessageAgeSec) ? body.lastMessageAgeSec : null,
          // round-3 audit (ADD 4): additive fields from the poller's zombie-
          // watchdog liveness gate — makes the next stall investigation
          // answerable from this log line alone, no second YouTube API
          // cross-check. Same null-when-absent handling as the two fields
          // above, so an old poller build (pre-liveness-gate) logs a
          // byte-compatible line here rather than an error.
          liveness: typeof body.liveness === 'string' ? body.liveness : null,
          watchdogThresholdMin: Number.isFinite(body.watchdogThresholdMin) ? body.watchdogThresholdMin : null,
        }));
        // Both fields optional and independent — the poller only sends them
        // while a live session holds a current video id (see its videoId
        // lifecycle notes); absent fields here just mean "no update", never an
        // error. Stamping ytCountsAt only when a field actually lands means a
        // heartbeat with neither field can't quietly reset the staleness clock.
        let gotCounts = false;
        let changed = false;
        if (Number.isFinite(body.viewers)) {
          if (body.viewers !== this.ytViewers) {
            changed = true;
            console.log(JSON.stringify({ ev: 'counts_update', metric: 'ytViewers', outcome: 'ok', value: body.viewers }));
          }
          this.ytViewers = body.viewers;
          gotCounts = true;
        }
        if (Number.isFinite(body.likes)) {
          if (body.likes !== this.ytLikes) {
            changed = true;
            console.log(JSON.stringify({ ev: 'counts_update', metric: 'ytLikes', outcome: 'ok', value: body.likes }));
          }
          this.ytLikes = body.likes;
          gotCounts = true;
        }
        if (gotCounts) this.ytCountsAt = Date.now();
        // Push-on-change: don't make the viewer wait out the 25s heartbeat tick
        // for a number that already changed. The heartbeat keeps broadcasting
        // status regardless — this is an addition, never a replacement.
        if (changed) this.broadcastEvent('status', this.buildStatusPayload());
        return new Response('ok', { status: 200 });
      }
      // Mod-action control message — mirrors shipped Twitch CLEARMSG/CLEARCHAT
      // handling (mark-in-place + gray info row), never falls through to
      // normalizeYt's chat-message validation. Scoped to the poller's own
      // secret: the raid-queue cron caller shares this route for
      // membership-renewal chat POSTs, but must never gain chat-moderation
      // capability (marking arbitrary rows/authors deleted) just because both
      // callers write to the same feed — same privilege-confusion class the
      // two-secret split already exists to prevent (see CLAUDE.md).
      if (body && body.type === 'mod') {
        if (req.headers.get('x-multichat-caller') !== 'poller') {
          return new Response('forbidden', { status: 403 });
        }
        if (body.action === 'delete') {
          const ytId = typeof body.ytId === 'string' && body.ytId.trim() ? body.ytId.slice(0, 128) : null;
          if (!ytId) return new Response('missing ytId', { status: 400 });
          this.applyYtDelete(ytId);
          return new Response('ok', { status: 200 });
        }
        if (body.action === 'author_delete') {
          const authorId = typeof body.authorId === 'string' && body.authorId.trim() ? body.authorId.slice(0, 128) : null;
          if (!authorId) return new Response('missing authorId', { status: 400 });
          this.applyYtAuthorDelete(authorId);
          return new Response('ok', { status: 200 });
        }
        if (body.action === 'mode_change') {
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return new Response('missing text', { status: 400 });
          this.applyYtModeChange(ellipsize(text, MODE_CHANGE_TEXT_MAX));
          return new Response('ok', { status: 200 });
        }
        return new Response('bad mod action', { status: 400 });
      }
      let normalized;
      try {
        normalized = normalizeYt(body);
      } catch (err) {
        return new Response(err.message, { status: 400 });
      }
      // Covers poller restarts (its own in-memory LRU is gone) and reconnect
      // overlap between the poller's own dedupe and ours.
      if (normalized.ytId && this.recentYtIds.has(normalized.ytId)) {
        return new Response('ok', { status: 200 });
      }
      this.pushMessage('yt', normalized);
      if (normalized.ytId) addToBoundedSet(this.recentYtIds, normalized.ytId, RING_SIZE);
      return new Response('ok', { status: 200 });
    } finally {
      this.logIngestTiming(reqId, startedAt, seenSpans);
    }
  }

  // Emits the per-request ingest_timing ev log and folds the result into the
  // running delay accumulators the alarm()-cadence rollup reads (Phase 4).
  // handler_ms only ever has a nonzero value because handleIngestYt contains
  // an await (req.json()) — Date.now() is frozen across pure sync execution
  // in a Worker, so a span with no await would always read 0ms.
  logIngestTiming(reqId, startedAt, seenSpans) {
    const endedAt = Date.now();
    const handlerMs = endedAt - startedAt;
    const overlapSpans = [...seenSpans.keys()];
    let overlapMs = 0;
    for (const span of seenSpans.values()) {
      const spanStartInWindow = Math.max(startedAt, span.start);
      overlapMs += Math.max(0, endedAt - spanStartInWindow);
    }
    // Clamped so attributed+unattributed always sum to exactly handler_ms —
    // overlapMs itself can exceed handler_ms when multiple spans overlap
    // concurrently (it's a sum, not a deduped union), but the rollup wants a
    // clean split, not a number that can overshoot the delay it's explaining.
    const attributedMs = Math.min(handlerMs, overlapMs);
    const unattributedMs = Math.max(0, handlerMs - overlapMs);
    this.delayTotalMs += handlerMs;
    this.delayAttributedMs += attributedMs;
    this.delayUnattributedMs += unattributedMs;
    if (handlerMs > 1000) this.delayOver1s++;
    if (handlerMs > 5000) this.delayOver5s++;
    if (handlerMs > 10000) this.delayOver10s++;
    console.log(JSON.stringify({ ev: 'ingest_timing', req_id: reqId, handler_ms: handlerMs, overlap_spans: overlapSpans, overlap_ms: overlapMs }));
  }

  // Handles an already signature-verified EventSub notification forwarded
  // from the edge (handleEventSubCallback). SECURITY INVARIANT: the dedupe
  // gate below runs BEFORE any read of subscription.type / mapEventToRow —
  // a replayed message-id is dropped here regardless of what the body claims
  // its type is, closing the at-least-once-retry path Twitch's own docs call
  // out. subscription.type/version are read from the parsed (HMAC-covered)
  // body only — see the signed-truth note on handleEventSubCallback.
  //
  // The has()-check and the addToBoundedSet() insertion are kept on the same
  // synchronous tick (no await between them) — Twitch is at-least-once and
  // near-simultaneous redeliveries of the same id are a live path, not just
  // theoretical. Marking the id seen only *after* `await req.json()` would
  // leave a window where two concurrent deliveries both pass the has() check
  // before either records the id, producing a duplicate row.
  async handleEventSub(req) {
    const id = req.headers.get('x-es-id');
    if (!id) return new Response('missing id', { status: 400 });
    if (this.recentEventSubIds.has(id)) {
      return new Response('ok', { status: 200 }); // duplicate retry — dropped, never mapped
    }
    addToBoundedSet(this.recentEventSubIds, id, EVENTSUB_ID_MAX);
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response('bad json', { status: 400 });
    }
    const subType = body?.subscription?.type;
    const event = body?.event || {};
    // Hype Train level-gate: only a level-up renders a progress row — every
    // contribution otherwise fires channel.hype_train.progress, which would
    // flood the feed at exactly its busiest moments. Financial contributions
    // still render as their own gold IRC rows; nothing paid is lost.
    if (subType === 'channel.hype_train.progress') {
      if (!(Number.isFinite(event.level) && event.level > this.hypeLevel)) {
        return new Response('ok', { status: 200 });
      }
      this.hypeLevel = event.level;
    } else if (subType === 'channel.hype_train.begin') {
      this.hypeLevel = Number.isFinite(event.level) ? event.level : 0;
    } else if (subType === 'channel.hype_train.end') {
      this.hypeLevel = 0;
    }
    // Gigantify double-display suppression — see handleGigantifyDedupe. Runs
    // before the gold row pushes, but never gates it: this only ever acts on
    // the separate plain-chat ring entry, so a lookup miss/no-op here can
    // never suppress or delay the gold row itself.
    if (subType === 'channel.bits.use' && event.type === 'power_up' &&
        event.power_up && event.power_up.type === 'gigantify_an_emote') {
      // x-es-ts is the edge-verified Twitch-Eventsub-Message-Timestamp
      // (ISO 8601, ms precision) — see handleEventSubCallback. Date.parse
      // returns NaN for a missing/malformed header, which
      // pickGigantifyCandidate treats as "no timestamp, pick newest".
      const eventTs = Date.parse(req.headers.get('x-es-ts') || '');
      this.handleGigantifyDedupe(event, eventTs);
    }
    const row = mapEventToRow(subType, event);
    if (row) this.pushMessage('tw', row);
    return new Response('ok', { status: 200 });
  }

  // Fired by handleEventSubCallback's revocation branch. A live revocation
  // means a subscription just went dead *right now* — waiting out the daily
  // cadence a previously-healthy esAllHealthy state earned would leave the
  // gap open for up to 24h. Resetting esLastEnsured forces the very next
  // maybeEnsureEventSub tick (piggybacked on the 15s viewer-poll cadence) to
  // re-run ensureEventSubSubscriptions immediately, which rediscovers the
  // dead sub via the normal status-listing path and recreates it.
  handleEventSubRevoked() {
    this.esAllHealthy = false;
    this.esLastEnsured = 0;
    return new Response('ok', { status: 200 });
  }

  // B1: fast check-and-increment ONLY -- the actual env.AI.run generation and
  // audio streaming happen in the Worker (handleTts), never here. ChatHub is
  // single-threaded and holds every SSE client plus the IRC socket; awaiting
  // a TTS generation in here would put audio latency directly in the chat
  // hot path, and streaming the result back through the stub would pin a DO
  // request open for the whole generation. This call is a sub-millisecond
  // RPC returning a verdict, nothing more.
  //
  // Two independent ceilings, deliberately different persistence:
  //   - minute bucket: in-memory (this.ttsMinuteWindow/Count), resets on DO
  //     eviction -- fine, since its whole job is bursty-abuse-in-the-moment,
  //     not a spend ceiling.
  //   - daily character budget: ctx.storage (survives eviction) -- THIS is
  //     the actual spend ceiling, so it must not silently reset to 0 the
  //     next time the DO cold-starts mid-day. Window is UTC midnight (the
  //     stored day string vs today's, both from Date.prototype.toISOString
  //     which is always UTC) -- gate-2 confirms this, per Jon's ask.
  //
  // chars is pre-charged against the daily budget before generation runs --
  // a failed generation over-counts slightly. That errs toward
  // under-spending, which is the safer direction for a real-money endpoint.
  async handleTtsAllow(req) {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, reason: 'bad_request' }, { status: 400 });
    }
    const chars = Number(body.chars);
    if (!Number.isFinite(chars) || chars < 0) {
      return Response.json({ ok: false, reason: 'bad_request' }, { status: 400 });
    }

    const killed = await this.ctx.storage.get(TTS_KILL_STORAGE_KEY);
    if (killed) {
      console.log(JSON.stringify({ ev: 'tts_killed' }));
      return Response.json({ ok: false, reason: 'killed' });
    }

    const today = new Date().toISOString().slice(0, 10); // UTC date, e.g. '2026-08-24'
    // Read, cap-check, and write as one atomic unit -- covers BOTH ceilings.
    // Two concurrent /tts calls that both `get`/check before either commits
    // would otherwise both pass off the same stale state, and the later
    // write last-writer-wins over the earlier one, silently dropping an
    // increment (daily case) or letting both calls through the same minute
    // slot (minute case -- the minute check-and-increment used to live
    // outside this block, straddling this same await: two calls could both
    // see this.ttsMinuteCount at 19, both fall through here, and both
    // increment afterward, pushing the count past TTS_MINUTE_LIMIT).
    // blockConcurrencyWhile serializes this whole section against every
    // other request the DO would otherwise interleave at these awaits, so
    // folding the minute check in here too makes the entire gate one atomic
    // read-check-write. Limits and reset behavior are unchanged -- minute
    // bucket is still in-memory (resets on DO eviction, burst-shape only,
    // per the premortem), daily budget is still ctx.storage (survives
    // eviction, the actual spend ceiling), UTC-midnight reset unchanged.
    let verdict;
    await this.ctx.blockConcurrencyWhile(async () => {
      const nowMinute = Math.floor(Date.now() / 60_000);
      if (this.ttsMinuteWindow !== nowMinute) {
        this.ttsMinuteWindow = nowMinute;
        this.ttsMinuteCount = 0;
      }
      if (this.ttsMinuteCount >= TTS_MINUTE_LIMIT) {
        console.log(JSON.stringify({ ev: 'tts_throttled', count: this.ttsMinuteCount, limit: TTS_MINUTE_LIMIT }));
        verdict = { ok: false, reason: 'minute', count: this.ttsMinuteCount, limit: TTS_MINUTE_LIMIT };
        return;
      }

      let daily = (await this.ctx.storage.get(TTS_DAILY_STORAGE_KEY)) || { day: today, chars: 0 };
      if (daily.day !== today) daily = { day: today, chars: 0 };
      if (daily.chars + chars > TTS_DAILY_CHAR_BUDGET) {
        console.log(JSON.stringify({ ev: 'tts_budget_exhausted', chars: daily.chars, cap: TTS_DAILY_CHAR_BUDGET }));
        verdict = { ok: false, reason: 'budget', chars: daily.chars, cap: TTS_DAILY_CHAR_BUDGET };
        return;
      }
      daily.chars += chars;
      await this.ctx.storage.put(TTS_DAILY_STORAGE_KEY, daily);
      this.ttsMinuteCount++;
      verdict = { ok: true };
    });
    return Response.json(verdict);
  }

  // Admin path, gated by requireOverlayToken / MULTICHAT_OVERLAY_SECRET at
  // the Worker edge (handleOverlayAdmin) — restored 2026-08-27 after a brief
  // unauthenticated window. Same secret as /tts and /overlay/config, not a
  // separate admin secret. Only op supported today is tts_kill.
  async handleTtsAdmin(req) {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, reason: 'bad_request' }, { status: 400 });
    }
    if (body.op !== 'tts_kill') {
      return Response.json({ ok: false, reason: 'unknown_op' }, { status: 400 });
    }
    const on = Boolean(body.on);
    await this.ctx.storage.put(TTS_KILL_STORAGE_KEY, on);
    console.log(JSON.stringify({ ev: 'tts_kill_set', on }));
    return Response.json({ ok: true, killed: on });
  }

  // Single removal path for an SSE client — logs the stream's lifetime and
  // clears both the client set and its metadata. The enqueue-catch path used
  // to only delete from `this.clients` (bypassing cancel()), which is exactly
  // how a half-open stream could leak; routing every removal through here keeps
  // clients and clientMeta in lockstep.
  dropClient(controller, reason) {
    const meta = this.clientMeta.get(controller);
    if (meta) {
      console.log(JSON.stringify({ ev: 'sse_close', sseId: meta.sseId, durationMs: Date.now() - meta.openedAt, reason }));
      this.clientMeta.delete(controller);
    }
    this.clients.delete(controller);
  }

  // Per-client enqueue — one dead controller must never break the loop for
  // the others, so the catch (and resulting dropClient) stays scoped here.
  enqueueBytes(controller, bytes) {
    try {
      controller.enqueue(bytes);
    } catch {
      this.dropClient(controller, 'enqueue-error');
    }
  }

  // Replay-only writer — confirmed sole caller is the ring-replay loop
  // above, never broadcast()'s live path. Tags the frame `replay: true`
  // for the overlay's entry-animation suppression (B3: TTS suppression
  // itself stays governed by isEmittable's own floor+spokenIds+TTL, NOT by
  // this flag — a message replayed after a transient reconnect may be
  // genuinely unheard and should still speak). Spreads into a new object
  // rather than mutating msg in place, since msg is the SAME object stored
  // in this.ring — a live broadcast of that same ring entry later must not
  // carry a stale replay:true from an earlier reconnect. Backward-safe: the
  // PWA's client only ever does JSON.parse + property reads on this payload
  // (never a strict shape check), so the added key is silently ignored there.
  sendToController(controller, msg) {
    const framed = { ...msg, replay: true };
    this.enqueueBytes(controller, ENC.encode(`id: ${msg.id}\ndata: ${JSON.stringify(framed)}\n\n`));
  }

  // Named SSE event (ping / status) — distinct from the default "message"
  // event so the client can tell a liveness signal from a chat message
  // without parsing payloads.
  sendEventTo(controller, event, dataObj) {
    this.enqueueBytes(controller, ENC.encode(`event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`));
  }

  // Reaps dead/zombie SSE readers on each heartbeat tick — the actual fix for
  // the watchdog-with-zero-live-clients chain (a half-open controller that
  // never threw on enqueue, so cancel() never fired, kept clients.size > 0 and
  // re-armed the watchdog forever). Two independent backstops:
  //  (a) backpressure: a controller whose desiredSize stays negative across
  //      REAP_STRIKE_LIMIT consecutive ticks isn't draining → dead reader.
  //  (b) max age: any stream older than MAX_SSE_AGE_MS is force-closed; the
  //      client auto-reconnects with Last-Event-ID (no gap).
  reapDeadClients() {
    const now = Date.now();
    for (const controller of [...this.clients]) {
      const meta = this.clientMeta.get(controller);
      if (meta && now - meta.openedAt > MAX_SSE_AGE_MS) {
        this.closeClient(controller, 'max-age');
        continue;
      }
      let ds = null;
      try { ds = controller.desiredSize; } catch { ds = null; }
      if (ds !== null && ds < 0) {
        if (meta && ++meta.strikes >= REAP_STRIKE_LIMIT) this.closeClient(controller, 'backpressure');
      } else if (meta) {
        meta.strikes = 0; // healthy reading resets the strike counter
      }
    }
  }

  closeClient(controller, reason) {
    const meta = this.clientMeta.get(controller);
    console.log(JSON.stringify({ ev: 'reap', sseId: meta ? meta.sseId : null, reason }));
    if (reason === 'backpressure') {
      // Best available backlog signal: there's no per-client queued-message
      // array (fan-out enqueues straight to the controller), so desiredSize
      // (negative = bytes past the stream's high-water mark) plus how many
      // consecutive reap ticks it stayed negative is what's real to log.
      let desiredSize = null;
      try { desiredSize = controller.desiredSize; } catch { desiredSize = null; }
      console.log(JSON.stringify({
        ev: 'sse_reap_backlog',
        sseId: meta ? meta.sseId : null,
        strikes: meta ? meta.strikes : null,
        desiredSize,
      }));
    }
    try { controller.close(); } catch {}
    this.dropClient(controller, reason);
  }

  // Encode once, enqueue the same bytes to every client — the SSE stream is a
  // default (non-byte) ReadableStream, so enqueue() does not detach the
  // shared buffer. Per-client dead-controller handling still lives in
  // enqueueBytes, so one bad client never breaks the loop for the rest.
  broadcast(msg) {
    const bytes = ENC.encode(`id: ${msg.id}\ndata: ${JSON.stringify(msg)}\n\n`);
    for (const controller of this.clients) this.enqueueBytes(controller, bytes);
  }

  broadcastEvent(event, dataObj) {
    const bytes = ENC.encode(`event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`);
    for (const controller of this.clients) this.enqueueBytes(controller, bytes);
  }

  buildStatusPayload() {
    const now = Date.now();
    return {
      tw: this.lastSeen.tw ? now - this.lastSeen.tw : null,
      yt: this.lastSeen.yt ? now - this.lastSeen.yt : null,
      counts: {
        twViewers: countField(this.twViewers, this.twViewersAt, TW_VIEWERS_STALE_MS, now),
        twFollowers: countField(this.twFollowers, this.twFollowersAt, TW_FOLLOWERS_STALE_MS, now),
        ytViewers: countField(this.ytViewers, this.ytCountsAt, YT_COUNTS_STALE_MS, now),
        ytLikes: countField(this.ytLikes, this.ytCountsAt, YT_COUNTS_STALE_MS, now),
      },
    };
  }

  pushMessage(platform, data, meta = {}) {
    const msg = {
      id: ++this.nextId,
      platform,
      user: data.user,
      ...(data.color ? { color: data.color } : {}),
      ...(data.kind ? { kind: data.kind } : {}),
      ...(data.sys ? { sys: data.sys } : {}),
      ...(data.amount ? { amount: data.amount } : {}),
      // Structured field, not parsed from text — 0 is a valid "hidden streak"
      // value distinct from "no streak data at all" (undefined), so this
      // checks presence, not truthiness.
      ...(data.streakMonths !== undefined ? { streakMonths: data.streakMonths } : {}),
      // false is a real "user hid their streak" signal distinct from
      // "no signal at all" (undefined, tag absent) — presence check, not
      // truthiness, same shape as streakMonths above. Consumed only by
      // formatUtterance's leak gate; display path never reads this.
      ...(data.shouldShareStreak !== undefined ? { shouldShareStreak: data.shouldShareStreak } : {}),
      // Channel-point redemption fields — already capped (REWARD_TITLE_MAX /
      // USER_INPUT_MAX) by mapEventToRow before ever reaching pushMessage;
      // viewer-controlled text must never enter the ring uncapped.
      ...(data.rewardTitle ? { rewardTitle: data.rewardTitle } : {}),
      ...(data.userInput ? { userInput: data.userInput } : {}),
      ...(data.isMod ? { isMod: true } : {}),
      ...(data.isMember ? { isMember: true } : {}),
      ...(data.firstMsg ? { firstMsg: true } : {}),
      ...(data.emotes && data.emotes.length ? { emotes: data.emotes } : {}),
      ...(data.emote && data.emote.id ? { emote: data.emote } : {}),
      ...(data.gifs && data.gifs.length ? { gifs: data.gifs } : {}),
      ...(data.recovered ? { recovered: true } : {}),
      text: data.text,
      ts: Date.now(),
    };
    // login is the lowercase IRC identity (matches CLEARCHAT's target param and
    // CLEARMSG's login tag); user is the display name and must never be used
    // for mod-action matching — they differ for most users, entirely for CJK names.
    if (platform === 'tw' && data.login) msg.login = data.login;
    if (platform === 'tw' && meta.id) msg.twId = meta.id;
    // Twitch's own tmi-sent-ts (ms), distinct from msg.ts (our receipt clock)
    // above — handleGigantifyDedupe's candidate selection compares this
    // against the EventSub envelope timestamp, both Twitch-side clocks.
    if (platform === 'tw' && meta.ts) msg.twTs = meta.ts;
    if (platform === 'yt' && data.ytId) msg.ytId = data.ytId;
    if (platform === 'yt' && data.authorId) msg.authorId = data.authorId;
    const lateMark = platform === 'yt' ? this.resolvePendingYtMod(msg) : null;
    this.ring.push(msg);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.lastSeen[platform] = msg.ts;
    if (platform === 'tw') {
      if (meta.id) this.rememberTwitchId(meta.id);
      if (meta.ts && meta.ts > this.lastTwTmiSentTs) this.lastTwTmiSentTs = meta.ts;
    }
    // Enumerable per-donation server log — platform/kind/user/amount/ts only,
    // never the message body (privacy + capture trust rule). This is what makes
    // donations recoverable in Workers Observability from now on.
    if (msg.kind && FINANCIAL_KINDS.has(msg.kind)) {
      console.log(JSON.stringify({ ev: 'financial', platform, kind: msg.kind, user: msg.user, amount: msg.amount || null, ts: msg.ts }));
      // Separate, narrowly-gated log — NOT folded into the line above, which
      // fires on every financial row regardless of TTS. This one exists only
      // to accumulate real separator-name cases (post-Step1 cleanup) for
      // evaluating the deferred Step2 rule; low volume by design (financial
      // kind AND a separator survives cleanup), scoped to the same kind
      // predicate emitCategory uses to decide what gets spoken client-side.
      const spokenName = cleanSpokenName(msg.user);
      if (/[_-]/.test(spokenName)) {
        console.log(JSON.stringify({ ev: 'tts_name_sep_candidate', name: spokenName }));
      }
    }
    this.broadcast(msg);
    if (lateMark) this.broadcastEvent('mark', lateMark);
    return msg;
  }

  // Checks a freshly-built yt entry against both pending-mod buffers before
  // it's pushed — a hit means this entry's own delete/author_delete already
  // arrived and no-op'd (see applyYtDelete/applyYtAuthorDelete). Marks the
  // entry deleted before it's ever broadcast (so even the very first 'message'
  // event carries deleted:true, same as a ring-replay row) and returns the
  // mark payload so pushMessage can also fire the live 'mark' event, matching
  // the on-time-delete path exactly for already-connected clients.
  resolvePendingYtMod(msg) {
    const now = Date.now();
    if (msg.ytId && this.pendingYtDeletes.has(msg.ytId)) {
      const ts = this.pendingYtDeletes.get(msg.ytId);
      this.pendingYtDeletes.delete(msg.ytId);
      if (now - ts <= PENDING_MOD_TTL_MS) {
        msg.deleted = true;
        return { action: 'delete', targetId: msg.ytId, platform: 'yt' };
      }
    }
    if (msg.authorId && this.pendingAuthorDeletes.has(msg.authorId)) {
      const ts = this.pendingAuthorDeletes.get(msg.authorId);
      this.pendingAuthorDeletes.delete(msg.authorId);
      if (now - ts <= PENDING_MOD_TTL_MS) {
        msg.deleted = true;
        return { action: 'author_delete', authorId: msg.authorId, platform: 'yt' };
      }
    }
    return null;
  }

  // Mutates matching ring entries in place (deleted: true) so a replayed row
  // arrives already struck — no separate deletedTwIds/bannedUsers set, no
  // client reconciliation protocol. Matched by twId (delete) or login
  // (timeout/ban) — never by display name, which mod-action tags don't carry.
  markDeleted({ action, twId, login }) {
    for (const entry of this.ring) {
      if (entry.platform !== 'tw') continue;
      const hit = twId != null ? entry.twId === twId : entry.login === login;
      if (hit) entry.deleted = true;
    }
    this.broadcastEvent('mark', twId != null ? { action, targetId: twId } : { action, login });
  }

  // Mirrors markDeleted's in-place-ring-mutation + transient 'mark' broadcast
  // shape, but for the gigantify double-display fix: a fully-hidden row
  // (client never renders it at all), not a struck-through-but-visible one,
  // and always exactly one already-found entry — never a bulk login match
  // like markDeleted's ban/timeout path. Only ever called with a real ring
  // entry (see handleGigantifyDedupe), so no hit-or-miss branching here.
  // Skips the live broadcast (but still marks the ring entry, which is what
  // a reconnecting client's replay actually reads) when the entry has no
  // twId — real Twitch PRIVMSGs always carry one, but a login-wide fallback
  // selector would risk hiding an unrelated live message from the same user,
  // which the double-hide-risk side of this feature must never do.
  // reason carries whichever match details the caller has on hand (order,
  // the gigantifying emote name/id, and either eventTs — IRC-first, the
  // EventSub envelope timestamp pickGigantifyCandidate matched against — or
  // pendingTs — EventSub-first, when the gold was buffered) so a supersede
  // decision is debuggable after the fact without re-deriving it from the
  // ring. Every supersede goes through here (both call sites), so this is
  // the single log point for the whole dedupe feature.
  markSuperseded(entry, reason = {}) {
    entry.superseded = true;
    console.log(JSON.stringify({
      ev: 'gigantify_superseded',
      order: reason.order || null,
      login: entry.login || null,
      twId: entry.twId != null ? entry.twId : null,
      entryTs: Number.isFinite(entry.twTs) ? entry.twTs : (entry.ts != null ? entry.ts : null),
      emoteName: reason.emoteName || null,
      emoteId: reason.emoteId || null,
      eventTs: Number.isFinite(reason.eventTs) ? reason.eventTs : null,
      pendingTs: Number.isFinite(reason.pendingTs) ? reason.pendingTs : null,
      windowMs: GIGANTIFY_SUPPRESS_WINDOW_MS,
    }));
    if (entry.twId != null) {
      this.broadcastEvent('mark', { action: 'supersede', targetId: entry.twId });
    }
  }

  // Gigantify an Emote double-display suppression, IRC-first half (the
  // common order — Twitch's IRC edge usually delivers the plain PRIVMSG
  // before the channel.bits.use webhook lands). Called from handleEventSub
  // only for a gigantify_an_emote power_up event, before/regardless of
  // whether the gold row itself renders — the gold row is NEVER gated on
  // this. Scans the ring for candidate rows (see selectGigantifyCandidates)
  // and, if any exist, supersedes the one closest in time to the EventSub
  // notification's own envelope timestamp (eventTs — see pickGigantifyCandidate;
  // ties/missing eventTs resolve to the newest candidate). Picking "closest",
  // not "first found" (was `ring.find`, oldest-match) matters because the
  // gigantify's own PRIVMSG is usually the *newest* same-login match — a
  // same-login spam-then-gigantify sequence ("Kappa … Kappa … *gigantifies
  // Kappa*") would otherwise supersede the earlier, unrelated real message.
  // No candidates: IRC hasn't delivered it yet — remember this gold for
  // consumePendingGigantify to catch on arrival (EventSub-first order).
  // Fails open (does nothing) if the event carries no login or no emote
  // name — never touches the ring on incomplete data.
  handleGigantifyDedupe(event, eventTs) {
    const login = typeof event.user_login === 'string' ? event.user_login.toLowerCase() : '';
    const emoteName = event.power_up && event.power_up.emote && typeof event.power_up.emote.name === 'string'
      ? event.power_up.emote.name
      : '';
    const emoteId = event.power_up && event.power_up.emote && typeof event.power_up.emote.id === 'string'
      ? event.power_up.emote.id
      : '';
    if (!login || !emoteName) return;
    const now = Date.now();
    const candidates = selectGigantifyCandidates(this.ring, { login, emoteName, emoteId, now });
    const match = pickGigantifyCandidate(candidates, eventTs);
    if (match) {
      this.markSuperseded(match, { order: 'irc_first', emoteName, emoteId, eventTs });
      return;
    }
    this.pendingGigantifies.push({ login, emoteName, emoteId, ts: now });
    while (this.pendingGigantifies.length > PENDING_MOD_MAX) this.pendingGigantifies.shift();
  }

  // Gigantify an Emote double-display suppression, EventSub-first half —
  // the gold row already arrived (handleGigantifyDedupe above found no
  // matching ring entry yet and buffered it here) before this PRIVMSG did.
  // Called from handleIrcData for every plain-chat PRIVMSG, AFTER it has
  // already been pushed normally (ring/recentTwitchIds/lastTwTmiSentTs/SSE
  // all fire exactly as for any other message — see handleIrcData). A hit
  // here means the caller must immediately call markSuperseded on the just-
  // pushed row, reusing the exact same in-place-mutation + transient-
  // broadcast path as the IRC-first branch above — one suppression
  // mechanism, two triggers. Consumes (splices out) at most one matching
  // pending entry so a single gigantify can only ever suppress one PRIVMSG,
  // and opportunistically drops anything past GIGANTIFY_SUPPRESS_WINDOW_MS
  // on every call so the buffer can't accumulate stale entries between
  // gigantify events. Returns the consumed pending entry (truthy — {login,
  // emoteName, emoteId, ts}) iff the caller should supersede this row, else
  // null; the caller forwards emoteName/emoteId/ts into markSuperseded's log
  // line, since this function is the only place that still has them once a
  // match is found. Applies the SAME two-tier match rule
  // selectGigantifyCandidates uses for the IRC-first order (see
  // gigantifyRowMatches) — without it, a same-login row carrying
  // non-matching emote ids could be wrongly superseded by a coincidental
  // text-token match (PR41 review finding R1).
  consumePendingGigantify(login, text, emotes) {
    if (!this.pendingGigantifies.length) return null;
    const now = Date.now();
    const loginLc = typeof login === 'string' ? login.toLowerCase() : '';
    let hitEntry = null;
    this.pendingGigantifies = this.pendingGigantifies.filter((p) => {
      if (now - p.ts > GIGANTIFY_SUPPRESS_WINDOW_MS) return false; // expired — drop
      if (!hitEntry && p.login === loginLc && gigantifyRowMatches({ text, emotes }, { emoteId: p.emoteId, emoteName: p.emoteName })) {
        hitEntry = p;
        return false; // consumed — never matches a second PRIVMSG
      }
      return true;
    });
    return hitEntry;
  }

  applyClearmsg({ targetId, login }) {
    this.markDeleted({ action: 'delete', twId: targetId });
    // Strike-mark always happens (above) — IRC is fast and works even if
    // EventSub lags or drops. The gray attribution row is owned by
    // channel.moderate once it's healthy (renders "<mod> deleted <user>'s
    // message" instead); IRC's own target-only row only fires as the
    // fallback, so one delete never produces two rows. See
    // docs/ARCHITECTURE.md §3a for the ownership rule and its accepted
    // mirror-window bound.
    if (!this.esModerateHealthy) {
      this.pushMessage('tw', { user: login, login, sys: 'deleted', text: `${login}'s message deleted` });
    }
  }

  // YouTube analogs of markDeleted/applyClearmsg/applyClearchat above — same
  // in-place ring mutation + transient 'mark' broadcast, matched by ytId
  // (single message) or authorId (all of one author's visible rows), never by
  // display name (YT mod-action payloads don't carry one reliably).
  markDeletedYt({ ytId, authorId }) {
    for (const entry of this.ring) {
      if (entry.platform !== 'yt') continue;
      const hit = ytId != null ? entry.ytId === ytId : entry.authorId === authorId;
      if (hit) entry.deleted = true;
    }
    this.broadcastEvent('mark', ytId != null
      ? { action: 'delete', targetId: ytId, platform: 'yt' }
      : { action: 'author_delete', authorId, platform: 'yt' });
  }

  // Mirrors applyClearmsg exactly: mark-in-place + a gray info row. YT's
  // delete action only carries the target message id (no author name), so the
  // row text is looked up from the ring before mutating; if the target has
  // already scrolled out of the 200-entry ring, degrade to generic text
  // rather than drop the row.
  applyYtDelete(ytId) {
    const found = this.ring.find((e) => e.platform === 'yt' && e.ytId === ytId);
    this.markDeletedYt({ ytId });
    // Target not in the ring yet — could be the retry queue's concurrency-4
    // batch reordering this delete ahead of its own message (see
    // PENDING_MOD_TTL_MS above), or a genuinely already-scrolled-out target.
    // Buffer either way: pushMessage checks this on every yt insert, and an
    // unclaimed entry just silently expires/evicts — no different from today's
    // no-op for the already-scrolled-out case.
    if (!found) addToBoundedMap(this.pendingYtDeletes, ytId, Date.now(), PENDING_MOD_MAX);
    this.pushMessage('yt', { sys: 'deleted', text: found ? `${found.user}'s message deleted` : 'a message was deleted' });
  }

  // Mirrors applyClearchat's ban/timeout-by-login parity: strike every
  // visible row from that author plus one gray info row naming them when
  // findable (the point of the row is knowing WHOSE messages got nuked).
  applyYtAuthorDelete(authorId) {
    const found = this.ring.find((e) => e.platform === 'yt' && e.authorId === authorId);
    this.markDeletedYt({ authorId });
    // Same race as applyYtDelete above, covering the author_delete side.
    if (!found) addToBoundedMap(this.pendingAuthorDeletes, authorId, Date.now(), PENDING_MOD_MAX);
    this.pushMessage('yt', { sys: 'deleted', text: found ? `${found.user}'s messages were removed` : "A viewer's messages were removed" });
  }

  // ROOMSTATE parity for YouTube (slow/sub-only/emote-only toggles) — gray
  // info row, same shape as Twitch's applyRoomstate below. text already
  // fully formed by the poller (liveChatModeChangeMessageRenderer's own
  // text.runs), ellipsized by the caller before this is invoked.
  applyYtModeChange(text) {
    this.pushMessage('yt', { sys: 'modechange', text });
  }

  applyClearchat(result) {
    if (result.clear) {
      // Bare CLEARCHAT (full clear): record it, never wipe the feed, never
      // mark rows. Always pushed regardless of esModerateHealthy —
      // channel.moderate never renders a 'clear' action, so IRC keeps sole
      // ownership here; no dedupe risk.
      this.pushMessage('tw', { sys: 'clear', text: 'chat cleared' });
      return;
    }
    const { login, seconds } = result;
    // Strike-mark always happens (below) regardless of ownership — IRC is
    // fast and works even if EventSub lags or drops. The attributed gray row
    // is owned by channel.moderate once it's healthy; IRC's own target-only
    // row is the fallback, so one timeout/ban never produces two rows. See
    // docs/ARCHITECTURE.md §3a.
    if (seconds != null) {
      this.markDeleted({ action: 'timeout', login });
      if (!this.esModerateHealthy) {
        this.pushMessage('tw', { user: login, login, sys: 'timeout', text: `timeout: ${login}, ${seconds}s` });
      }
    } else {
      this.markDeleted({ action: 'ban', login });
      if (!this.esModerateHealthy) {
        this.pushMessage('tw', { user: login, login, sys: 'ban', text: `ban: ${login}` });
      }
    }
  }

  // First ROOMSTATE after each (re)connect is Twitch's full-state burst —
  // swallowed, not shown. Later ROOMSTATEs carry only the changed key(s).
  applyRoomstate(settings) {
    if (!this.roomStateInit) {
      this.roomStateInit = true;
      return;
    }
    for (const text of Object.values(settings)) {
      this.pushMessage('tw', { sys: 'roomstate', text });
    }
  }

  pushCapture(line) {
    this.captureBuf.push({ ts: Date.now(), line });
    if (this.captureBuf.length > CAPTURE_MAX_BUFFER) this.captureBuf.shift();
    // Mid-session burst trigger only — fire-and-forget. The alarm/idle-teardown/
    // socket-close paths await this same method so the DO doesn't evict mid-write.
    if (this.captureBuf.length >= CAPTURE_FLUSH_LINES) this.flushCapture();
  }

  async flushCapture() {
    if (!this.captureBuf.length) return;
    const batch = this.captureBuf;
    this.captureBuf = [];
    const ndjson = batch.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    const key = `capture/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.ndjson`;
    try {
      await this.env.CAPTURE.put(key, ndjson);
    } catch (err) {
      // exhaust sink down/misconfigured — drop this batch, never block chat delivery
      console.error('capture flush failed', key, err);
    }
  }

  rememberTwitchId(id) {
    addToBoundedSet(this.recentTwitchIds, id, RING_SIZE);
  }

  // Fetches the gap from Twitch's own IRC-tag timestamp — not our receipt
  // ts — so recovery is exact even if the DO was slow/evicted. Runs after
  // reconnect only; never awaited by the reconnect path itself.
  async recoverGap() {
    try {
      const cutoffTs = this.lastTwTmiSentTs;
      const floorTs = Date.now() - RECOVER_MAX_AGE_MS;
      let body;
      // span contains early-return control flow; intentionally not spannedFetch()
      const spanId = beginFetchSpan('backfill');
      // outcome flips to 'ok' only once the fetch resolves — a throw/abort
      // (the slow-then-failed case this span exists to catch) must still log,
      // hence the finally.
      let fetchOutcome = 'error';
      try {
        const res = await fetch(
          `https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(this.env.TWITCH_CHANNEL)}`,
          { signal: AbortSignal.timeout(RECOVER_TIMEOUT_MS) }
        );
        fetchOutcome = 'ok';
        if (!res.ok) return;
        body = await res.json();
      } finally {
        endFetchSpan(spanId, fetchOutcome);
      }
      if (!body || !Array.isArray(body.messages)) return;
      const recovered = filterRecoveredMessages(body.messages, {
        cutoffTs,
        floorTs,
        seenIds: this.recentTwitchIds,
      }).slice(-RING_SIZE);
      for (const { ts, twId, data } of recovered) {
        this.pushMessage('tw', data, { id: twId, ts });
      }
    } catch {
      // service down/slow/malformed — skip silently, reconnect already succeeded
    }
  }

  startHeartbeat() {
    this.startTwitchViewerPoll(); // same attached-clients lifecycle as the SSE heartbeat below
    this.startTwitchFollowerPoll();
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.broadcastEvent('ping', {});
      this.broadcastEvent('status', this.buildStatusPayload());
      this.reapDeadClients();
      // If reaping emptied the set, tear the heartbeat down here rather than
      // waiting for the watchdog alarm — the zombie that pinned the DO is gone.
      if (this.clients.size === 0) {
        this.stopHeartbeat();
        this.scheduleIdleDisconnect();
      }
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.stopTwitchViewerPoll();
    this.stopTwitchFollowerPoll();
  }

  // Helix "Get Streams" viewer-count polling — gated on the same
  // clients-attached lifecycle as the SSE heartbeat (never polled to an empty
  // room). Fires one immediate poll on start so the count appears without
  // waiting a full TWITCH_HELIX_POLL_MS.
  startTwitchViewerPoll() {
    if (this.twViewerPollTimer) return;
    this.pollTwitchViewers();
    this.maybeEnsureEventSub(); // piggybacked on this cadence — see maybeEnsureEventSub
    this.twViewerPollTimer = setInterval(() => {
      this.pollTwitchViewers();
      this.maybeEnsureEventSub();
    }, TWITCH_HELIX_POLL_MS);
  }

  stopTwitchViewerPoll() {
    if (this.twViewerPollTimer) {
      clearInterval(this.twViewerPollTimer);
      this.twViewerPollTimer = null;
    }
  }

  // client_credentials app access token — no user consent, read-only Helix
  // scope. Cached until shortly before expiry; TWITCH_CLIENT_ID/SECRET unset
  // (pre-registration) means this quietly no-ops and Twitch counts just never
  // populate, same failure-isolation shape as every other metrics fetch here.
  async getTwitchAppToken() {
    if (!this.env.TWITCH_CLIENT_ID || !this.env.TWITCH_CLIENT_SECRET) return null;
    const now = Date.now();
    if (this.twToken && now < this.twTokenExp) return this.twToken;
    try {
      const res = await spannedFetch('app_token', () => fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.env.TWITCH_CLIENT_ID,
          client_secret: this.env.TWITCH_CLIENT_SECRET,
          grant_type: 'client_credentials',
        }),
        signal: AbortSignal.timeout(TWITCH_API_TIMEOUT_MS),
      }));
      if (!res.ok) {
        // Misconfigured/revoked client_id+secret (e.g. 400) — never touch
        // chat flow, but log so a stuck Twitch app credential is diagnosable
        // instead of silently never populating a count forever.
        console.error('twitch app token request failed', res.status);
        return null;
      }
      const body = await res.json();
      if (!body || typeof body.access_token !== 'string') return null;
      this.twToken = body.access_token;
      // Refresh a minute early rather than racing an exact-expiry 401.
      this.twTokenExp = now + (Number(body.expires_in) || 0) * 1000 - 60_000;
      return this.twToken;
    } catch (err) {
      console.error('twitch app token fetch failed', err);
      return null;
    }
  }

  // Any failure here — token, network, bad response — must never touch chat
  // flow. It leaves the last known count in place; buildStatusPayload's
  // staleness check is what tells the client the number can no longer be
  // trusted, rather than this method guessing at when to blank it.
  async pollTwitchViewers() {
    // Feature-disabled fast path stays outside the span entirely (matches
    // getTwitchAppToken's own no-op guard) — otherwise an unconfigured app
    // would log a do_fetch_timing 'error' for helix_viewer_poll every cycle
    // forever, pure noise for a deliberately-off feature.
    if (!this.env.TWITCH_CLIENT_ID || !this.env.TWITCH_CLIENT_SECRET) return;
    try {
      // Span now wraps the app-token fetch and res.json() too, not just the
      // Helix fetch call — previously both landed in ingest-tail's
      // unattributed_ms despite being part of this same poll operation.
      // span contains early-return control flow; intentionally not spannedFetch()
      const spanId = beginFetchSpan('helix_viewer_poll');
      let fetchOutcome = 'error';
      let res;
      let body;
      try {
        const token = await this.getTwitchAppToken();
        if (!token) return;
        res = await fetch(
          `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(this.env.TWITCH_CHANNEL)}`,
          {
            headers: { 'Client-Id': this.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(TWITCH_API_TIMEOUT_MS),
          }
        );
        // 'ok' means "fetch didn't throw", independent of HTTP status —
        // same convention as every other spanned fetch in this file.
        fetchOutcome = 'ok';
        if (res.status === 401) {
          // Token invalid/revoked mid-lifetime — drop the cache so the next
          // poll fetches a fresh one instead of retrying the same bad token.
          this.twToken = null;
          this.twTokenExp = 0;
          return;
        }
        if (!res.ok) return;
        body = await res.json();
      } finally {
        // finally, not post-await: a throw must still emit the span (it
        // propagates on to the outer catch's console.error unchanged).
        endFetchSpan(spanId, fetchOutcome);
      }
      const stream = Array.isArray(body.data) ? body.data[0] : null;
      const viewers = stream && Number.isFinite(stream.viewer_count) ? stream.viewer_count : null;
      const changed = viewers !== this.twViewers;
      // Also log on recovery from a prior error even if the value landed back
      // on the same number — otherwise an outage that resolves to an
      // unchanged value leaves a dangling error with no resolution line.
      const recovered = this._twViewersLastError !== null;
      this._twViewersLastError = null;
      if (changed || recovered) {
        console.log(JSON.stringify({ ev: 'counts_update', metric: 'twViewers', outcome: 'ok', value: viewers }));
      }
      this.twViewers = viewers;
      this.twViewersAt = Date.now();
      // Push-on-change (see handleIngestYt) — the 25s heartbeat is the floor,
      // not the only path a fresh number can take to the client.
      if (changed) this.broadcastEvent('status', this.buildStatusPayload());
    } catch (err) {
      console.error('twitch viewers poll failed', err);
      // Gate on the message text, not just "was erroring" — a different
      // failure (error B) must still surface even while error A's flag is set.
      const msg = err && err.message ? err.message : String(err);
      if (msg !== this._twViewersLastError) {
        this._twViewersLastError = msg;
        console.error(JSON.stringify({ ev: 'counts_update', metric: 'twViewers', outcome: 'error', error: msg }));
      }
    }
  }

  startTwitchFollowerPoll() {
    if (this.twFollowerPollTimer) return;
    this.pollTwitchFollowers();
    this.twFollowerPollTimer = setInterval(() => this.pollTwitchFollowers(), TW_FOLLOWERS_POLL_MS);
  }

  stopTwitchFollowerPoll() {
    if (this.twFollowerPollTimer) {
      clearInterval(this.twFollowerPollTimer);
      this.twFollowerPollTimer = null;
    }
  }

  // User-token refresh chain for moderator:read:followers. ctx.storage (not
  // memory) holds the refresh token — the one exception to this DO's
  // in-memory-only state model, because Twitch rotates the refresh token on
  // every use and invalidates the old one. Losing it to a DO eviction would
  // permanently break the chain instead of just costing a cheap re-derive.
  // TWITCH_USER_REFRESH_TOKEN (secret) only ever seeds the chain: storage
  // always wins once it holds a value, and is retried against the seed
  // exactly once if the stored one is ever rejected (covers a manual
  // re-consent + fresh `wrangler secret put`). See docs/ARCHITECTURE.md.
  async getTwitchUserToken() {
    const now = Date.now();
    if (this.twUserToken && now < this.twUserTokenExp) return this.twUserToken;
    const stored = await this.ctx.storage.get(TW_USER_REFRESH_TOKEN_KEY);
    const seed = this.env.TWITCH_USER_REFRESH_TOKEN;
    const primary = stored || seed;
    if (!primary) return null; // never consented / secret not yet set — count stays hidden
    let token = await this.refreshTwitchUserToken(primary);
    if (token) return token;
    if (stored && seed && stored !== seed) {
      console.error(JSON.stringify({ ev: 'tw_user_token_refresh_failed', source: 'storage_chain' }));
      token = await this.refreshTwitchUserToken(seed);
      if (token) return token;
    }
    console.error(JSON.stringify({ ev: 'tw_user_token_refresh_failed', source: 'all' }));
    return null;
  }

  async refreshTwitchUserToken(refreshToken) {
    try {
      const res = await spannedFetch('token_refresh', () => fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.env.TWITCH_CLIENT_ID,
          client_secret: this.env.TWITCH_CLIENT_SECRET,
        }),
      }));
      if (!res.ok) return null;
      const body = await res.json();
      if (!body || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') return null;
      // Persist the rotated refresh token before the access token is used for
      // anything — worst case on a mid-write crash is one extra refresh next
      // poll, never a lost chain.
      await this.ctx.storage.put(TW_USER_REFRESH_TOKEN_KEY, body.refresh_token);
      this.twUserToken = body.access_token;
      this.twUserTokenExp = Date.now() + (Number(body.expires_in) || 0) * 1000 - 60_000;
      return this.twUserToken;
    } catch (err) {
      console.error('twitch user token refresh failed', err);
      return null;
    }
  }

  // Same failure-isolation shape as pollTwitchViewers: any error leaves the
  // last known total in place, countField's staleness math is what tells the
  // client it can no longer be trusted.
  async pollTwitchFollowers() {
    try {
      const token = await this.getTwitchUserToken();
      if (!token) return;
      const res = await spannedFetch('follower_poll', () => fetch(
        `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(this.env.TWITCH_BROADCASTER_ID)}`,
        { headers: { 'Client-Id': this.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
      ));
      if (res.status === 401) {
        // Access token invalid mid-lifetime — drop only the cached access
        // token, never the storage refresh chain; next poll re-derives it.
        this.twUserToken = null;
        this.twUserTokenExp = 0;
        return;
      }
      if (!res.ok) return;
      const body = await res.json();
      const total = Number.isFinite(body.total) ? body.total : null;
      const changed = total !== this.twFollowers;
      const recovered = this._twFollowersLastError !== null;
      this._twFollowersLastError = null;
      if (changed || recovered) {
        console.log(JSON.stringify({ ev: 'counts_update', metric: 'twFollowers', outcome: 'ok', value: total }));
      }
      this.twFollowers = total;
      this.twFollowersAt = Date.now();
      if (changed) this.broadcastEvent('status', this.buildStatusPayload());
    } catch (err) {
      console.error('twitch followers poll failed', err);
      const msg = err && err.message ? err.message : String(err);
      if (msg !== this._twFollowersLastError) {
        this._twFollowersLastError = msg;
        console.error(JSON.stringify({ ev: 'counts_update', metric: 'twFollowers', outcome: 'error', error: msg }));
      }
    }
  }

  // Gate for ensureEventSubSubscriptions: runs once per DO lifetime on the
  // first client attach (esOrigin is only set once a client has connected —
  // see handleEvents), then re-checked on an adaptive cadence while clients
  // remain attached, piggybacked on the existing 15s viewer-poll cadence
  // rather than a new alarm slot. While esAllHealthy is false (any desired
  // sub missing/wrong-version/dead, or EVENTSUB_SECRET not yet set) the
  // recheck runs hourly (EVENTSUB_ENSURE_RETRY_MS) so a late-placed secret or
  // a dead sub self-heals within the hour rather than waiting out a full day;
  // once every desired sub is confirmed healthy it backs off to
  // EVENTSUB_ENSURE_INTERVAL_MS. Twitch subs persist independent of DO
  // lifecycle, so this on-wake ensure is what recovers from a DO eviction
  // during the gap — there is no dedicated "subs are missing" alarm.
  maybeEnsureEventSub() {
    if (!this.esOrigin) return;
    const now = Date.now();
    const interval = this.esAllHealthy ? EVENTSUB_ENSURE_INTERVAL_MS : EVENTSUB_ENSURE_RETRY_MS;
    if (this.esEnsured && now - this.esLastEnsured < interval) return;
    this.esEnsured = true;
    this.esLastEnsured = now;
    const ensureStart = Date.now();
    this.ensureEventSubSubscriptions(this.esOrigin)
      .then(() => {
        console.log(JSON.stringify({ ev: 'do_fetch_timing', op: 'eventsub_ensure', durationMs: Date.now() - ensureStart, outcome: 'ok' }));
      })
      .catch((err) => {
        console.log(JSON.stringify({ ev: 'do_fetch_timing', op: 'eventsub_ensure', durationMs: Date.now() - ensureStart, outcome: 'error' }));
        console.error(JSON.stringify({ ev: 'eventsub_ensure_failed', err: String(err) }));
      });
  }

  // Reconciles Twitch's actual subscription state against buildDesiredSubs.
  // No-ops (leaving esAllHealthy untouched) whenever EVENTSUB_SECRET or
  // TWITCH_BROADCASTER_ID is unset, or the origin isn't public https — same
  // degrade-to-hidden shape as the other optional Twitch features, and it
  // never attempts to create a subscription with an empty transport secret.
  // Lists WITHOUT a status filter — status-blind listing is required to see
  // failed/revoked/pending subs at all, not just enabled ones. Per-desired-sub
  // handling:
  //   exact match (type+version+callback+condition), status enabled
  //     -> healthy, leave alone
  //   exact match, webhook_callback_verification_pending within 10min grace
  //     -> mid-handshake, leave alone, not yet healthy
  //   exact match, any other status (dead: revoked/failed/stuck-pending/...)
  //     -> loud ev log + delete+recreate
  //   same slot (type+callback+condition) but WRONG version
  //     -> loud ev log + delete the wrong-version sub, then create the
  //        correct one. Matching on version is required: without it, a
  //        stale/wrong-version enabled sub would be silently left running
  //        forever (violates the v1 pin) — and naively creating a new one
  //        without deleting the old would leave Twitch with two enabled subs
  //        of the same type, double-delivering every event.
  //   no match at all -> create
  // A 409 on create is benign (already exists, e.g. a race with a prior
  // ensure) and never fails the routine. esAllHealthy is set true only if
  // every desired sub ended this pass as an exact, enabled match.
  // One-time diagnostic (per DO lifetime, gated by esScopeChecked) for the
  // 403-vs-400 split found in a 2026-07-25 log audit: creates use an app
  // access token (getTwitchAppToken), but redemption/ad_break subscription
  // types still require the *broadcaster* to have granted this Client ID
  // channel:read:redemptions (or channel:manage:redemptions) / channel:read:ads
  // via some prior user-consent flow — Twitch checks that grant even though
  // the create call itself never sends a user token. Reuses the existing
  // follower-poll user-token refresh chain (getTwitchUserToken) purely to
  // read back that grant's scopes + user_id via Twitch's token-validate
  // endpoint; never mutates chat flow, and a failure here is swallowed like
  // every other diagnostics-only path in this class.
  async logEventSubScopeCheck() {
    if (this.esScopeChecked) return;
    this.esScopeChecked = true;
    try {
      const token = await this.getTwitchUserToken();
      if (!token) {
        console.error(JSON.stringify({ ev: 'eventsub_scope_check', ok: false, reason: 'no_user_token' }));
        return;
      }
      const res = await spannedFetch('eventsub_scope_check', () => fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': `OAuth ${token}` },
      }));
      if (!res.ok) {
        console.error(JSON.stringify({ ev: 'eventsub_scope_check', ok: false, status: res.status }));
        return;
      }
      const body = await res.json();
      const scopes = Array.isArray(body.scopes) ? body.scopes : [];
      const REQUIRED_EVENTSUB_SCOPES = ['channel:read:redemptions', 'channel:read:hype_train', 'channel:read:ads', 'bits:read'];
      const hasBitsRead = scopes.includes('bits:read');
      const hasAllEventSubScopes = REQUIRED_EVENTSUB_SCOPES.every((s) => scopes.includes(s));
      // channel.moderate v2's authorization is 8 OR-groups (each satisfied by
      // either its read or manage scope) — distinct shape from the flat
      // REQUIRED_EVENTSUB_SCOPES list above, so it gets its own structure
      // rather than being flattened into one array.
      const MODERATE_SCOPE_GROUPS = [
        ['moderator:read:blocked_terms', 'moderator:manage:blocked_terms'],
        ['moderator:read:chat_settings', 'moderator:manage:chat_settings'],
        ['moderator:read:unban_requests', 'moderator:manage:unban_requests'],
        ['moderator:read:banned_users', 'moderator:manage:banned_users'],
        ['moderator:read:chat_messages', 'moderator:manage:chat_messages'],
        ['moderator:read:warnings', 'moderator:manage:warnings'],
        ['moderator:read:moderators'],
        ['moderator:read:vips'],
      ];
      const hasAllModerateScopes = MODERATE_SCOPE_GROUPS.every((group) => group.some((s) => scopes.includes(s)));
      console.log(JSON.stringify({
        ev: 'eventsub_scope_check',
        userId: body.user_id,
        broadcasterMatch: body.user_id === this.env.TWITCH_BROADCASTER_ID,
        scopes,
        hasBitsRead,
        hasAllEventSubScopes,
        hasAllModerateScopes,
      }));
      // Stored so createEventSubSubscription can diagnose a later
      // channel.bits.use 403 without re-fetching — see that method.
      this.esScopeCheckResult = { hasBitsRead, hasAllEventSubScopes, hasAllModerateScopes, checkedAt: Date.now() };
    } catch (err) {
      console.error(JSON.stringify({ ev: 'eventsub_scope_check', ok: false, err: String(err) }));
    }
  }

  async ensureEventSubSubscriptions(origin) {
    if (!origin || !origin.startsWith('https:')) return; // no public callback reachable (local dev)
    if (!this.env.EVENTSUB_SECRET || !this.env.TWITCH_BROADCASTER_ID) return;
    const token = await this.getTwitchAppToken();
    if (!token) return;
    await this.logEventSubScopeCheck();
    const callback = `${origin}/eventsub/callback`;
    const desired = buildDesiredSubs(this.env.TWITCH_BROADCASTER_ID);
    let existing;
    try {
      existing = await this.listEventSubSubscriptions(token);
    } catch (err) {
      console.error(JSON.stringify({ ev: 'eventsub_list_failed', err: String(err) }));
      return;
    }
    const now = Date.now();
    let allHealthy = true;
    // Tracked separately from allHealthy — decides IRC-vs-EventSub row
    // ownership for moderation actions (see applyClearchat/applyClearmsg),
    // persisted below so a DO cold start doesn't forget a healthy sub.
    let moderateHealthy = false;
    for (const want of desired) {
      const sameSlot = (s) =>
        s.type === want.type &&
        s.transport?.callback === callback &&
        JSON.stringify(s.condition) === JSON.stringify(want.condition);
      const match = existing.find((s) => sameSlot(s) && s.version === want.version);
      if (!match) {
        const wrongVersion = existing.find(sameSlot);
        allHealthy = false;
        if (wrongVersion) {
          console.error(JSON.stringify({
            ev: 'eventsub_version_mismatch', type: want.type, id: wrongVersion.id,
            gotVersion: wrongVersion.version, wantVersion: want.version,
          }));
          const deleted = await this.deleteEventSubSubscription(token, wrongVersion.id);
          // Don't create the replacement until the old wrong-version sub is
          // confirmed gone — creating anyway would leave two enabled subs of
          // the same type, double-delivering every event. Next ensure pass
          // (hourly while unhealthy) retries the delete.
          if (!deleted) continue;
        }
        await this.createEventSubSubscription(token, want, callback);
        continue;
      }
      if (match.status === 'enabled') {
        if (want.type === 'channel.moderate') moderateHealthy = true;
        continue;
      }
      allHealthy = false;
      if (match.status === 'webhook_callback_verification_pending') {
        const createdAt = Date.parse(match.created_at || '');
        const age = Number.isFinite(createdAt) ? now - createdAt : Infinity;
        if (age < EVENTSUB_PENDING_GRACE_MS) continue; // still mid-handshake — never duplicate-create
        console.error(JSON.stringify({ ev: 'eventsub_stuck_pending', type: want.type, id: match.id, age }));
      } else {
        // enabled/pending already handled above — anything else is a dead
        // sub (notification_failures_exceeded, authorization_revoked,
        // user_removed, moderator_removed, version_removed, verification_failed, ...).
        console.error(JSON.stringify({ ev: 'eventsub_dead_sub', type: want.type, id: match.id, status: match.status }));
      }
      const deleted = await this.deleteEventSubSubscription(token, match.id);
      // Same reasoning as the wrong-version branch above: only replace a dead
      // sub once its deletion is confirmed, never leave two enabled subs of
      // the same type in flight.
      if (!deleted) continue;
      await this.createEventSubSubscription(token, want, callback);
    }
    this.esAllHealthy = allHealthy;
    this.esModerateHealthy = moderateHealthy;
    // Persisted (not just in-memory) — see the constructor's
    // blockConcurrencyWhile hydration and its comment for the accepted
    // mirror-window this closes (cold start) vs. the one it doesn't (a
    // revocation landing between the last persist and the next DO eviction).
    await this.ctx.storage.put('esModerateHealthy', moderateHealthy);
  }

  // Status-blind listing must be COMPLETE or not used at all — a page that
  // fails partway through pagination used to `break` silently (no log, no
  // throw), returning whatever partial list had accumulated so far as if it
  // were the whole thing. ensureEventSubSubscriptions would then treat any
  // desired sub that happened to live on a later, unfetched page as entirely
  // missing and try to (re)create it every cycle — a real, healthy,
  // currently-delivering subscription indistinguishable from a genuinely
  // missing one. Fail closed instead: log loudly and throw, so the caller's
  // existing try/catch (which already `return`s before touching any
  // per-sub create/delete logic) skips the ENTIRE reconcile pass on
  // incomplete data rather than reconciling against a partial view.
  async listEventSubSubscriptions(token) {
    const out = [];
    let cursor = '';
    do {
      const url = `https://api.twitch.tv/helix/eventsub/subscriptions${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await spannedFetch('eventsub_list', () => fetch(url, {
        headers: { 'Client-Id': this.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
      }));
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error(JSON.stringify({ ev: 'eventsub_list_incomplete', reason: 'page_not_ok', status: res.status, cursor, body: bodyText.slice(0, 500) }));
        throw new Error(`eventsub list page failed: ${res.status}`);
      }
      const body = await res.json();
      if (!Array.isArray(body.data)) {
        console.error(JSON.stringify({ ev: 'eventsub_list_incomplete', reason: 'malformed_page', cursor }));
        throw new Error('eventsub list page malformed: data is not an array');
      }
      out.push(...body.data);
      cursor = body.pagination?.cursor || '';
    } while (cursor);
    return out;
  }

  async createEventSubSubscription(token, want, callback) {
    try {
      const res = await spannedFetch('eventsub_create', () => fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          'Client-Id': this.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: want.type,
          version: want.version,
          condition: want.condition,
          transport: { method: 'webhook', callback, secret: this.env.EVENTSUB_SECRET },
        }),
      }));
      if (res.status === 409) {
        console.log(JSON.stringify({ ev: 'eventsub_create_conflict', type: want.type })); // benign — already exists
        return;
      }
      if (!res.ok) {
        // Body capture (not just status) is what actually distinguishes a
        // missing-scope 403 from a bad-version 400 from a broadcaster
        // mismatch — a prior incident where status alone left
        // every one of 20 failures unexplained for a full night.
        const bodyText = await res.text().catch(() => '');
        // channel.bits.use specifically also requires a broadcaster
        // bits:read consent grant (separate from the app-token create
        // call) — correlate against the last logEventSubScopeCheck result
        // so a 403 here doesn't require manually cross-referencing a
        // separate log line or parsing Twitch's raw error text.
        // esScopeCheckResult is checked once per DO lifetime (see
        // logEventSubScopeCheck) and never refreshed — a 'not_a_scope_issue'
        // diagnosis reflects the grant as of that one check, not a live
        // guarantee the scope is still present if revoked mid-lifetime.
        const diagnosis = want.type === 'channel.bits.use' && res.status === 403
          ? (this.esScopeCheckResult == null
              ? 'scope_check_unavailable'
              : this.esScopeCheckResult.hasBitsRead
                ? 'not_a_scope_issue'
                : 'scope_not_granted')
          : undefined;
        console.error(JSON.stringify({
          ev: 'eventsub_create_failed', type: want.type, status: res.status, body: bodyText.slice(0, 500),
          ...(diagnosis ? { diagnosis } : {}),
        }));
        return;
      }
      console.log(JSON.stringify({ ev: 'eventsub_created', type: want.type, version: want.version }));
    } catch (err) {
      console.error(JSON.stringify({ ev: 'eventsub_create_failed', type: want.type, err: String(err) }));
    }
  }

  // Returns true iff the subscription is confirmed gone (2xx or 404 — already
  // absent counts as success). Callers must check this before creating a
  // replacement: proceeding to create on a failed delete would leave the old
  // (wrong-version/dead) subscription still enabled alongside the new one,
  // double-delivering every event — exactly what delete-then-recreate exists
  // to prevent.
  async deleteEventSubSubscription(token, id) {
    try {
      const res = await spannedFetch('eventsub_delete', () => fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Client-Id': this.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
      }));
      if (!res.ok && res.status !== 404) {
        console.error(JSON.stringify({ ev: 'eventsub_delete_failed', id, status: res.status }));
        return false;
      }
      return true;
    } catch (err) {
      console.error(JSON.stringify({ ev: 'eventsub_delete_failed', id, err: String(err) }));
      return false;
    }
  }

  // Root cause of the ~2-3min tw_close/1006 cadence found in prod (2026-07-21
  // Observability investigation): the outbound Twitch socket was dying from
  // pure network-level silence with no traffic in either direction to defeat
  // an idle reaper, upstream of anything this DO controls or Twitch's own
  // RECONNECT command (0 received in that window). A self-sent PING is
  // inbound traffic once Twitch PONGs it back — it feeds lastSeen.tw exactly
  // like an inbound Twitch PING does, so IRC_SILENCE_MS (6min) stops being a
  // bet on Twitch's own ping schedule and becomes a true-death detector with
  // ~5 missed PONGs of margin (5 * IRC_KEEPALIVE_MS) instead of a thin ~1min
  // one. Always restarts clean (never the startHeartbeat re-entrant-guard
  // style) — each new socket gets its own ka1, ka2... sequence, never
  // continuing a stale connection's counter.
  startIrcKeepalive() {
    this.stopIrcKeepalive();
    this.ircKeepaliveSeq = 0;
    this.ircKeepaliveTimer = setInterval(() => {
      this.ircKeepaliveSeq++;
      try {
        this.socket?.send(`PING :ka${this.ircKeepaliveSeq}`);
      } catch {}
    }, IRC_KEEPALIVE_MS);
  }

  stopIrcKeepalive() {
    if (this.ircKeepaliveTimer) {
      clearInterval(this.ircKeepaliveTimer);
      this.ircKeepaliveTimer = null;
    }
  }

  // Cleanly recycles the Twitch socket every IRC_RECYCLE_MS so DO
  // console.log output — which only flushes when this socket closes (see
  // ARCHITECTURE.md) — never waits longer than this to surface. Independent
  // of the keepalive timer; the reconnect it triggers is the same
  // handleSocketDown -> backoff -> recoverGap path a network drop takes, so
  // the seam heals the same way (backfill + dedupe), no special-casing.
  //
  // Closes over `armedSocket` (the instance live when the timer was armed)
  // and re-checks `this.socket === armedSocket` before firing — the same
  // instance-guard shape as handleSocketDown's own check. Without it, a timer
  // armed for a socket that later dies and reconnects would fire at minute 30
  // of the OLD socket's life and could incorrectly close the NEW one.
  startIrcRecycle(armedSocket) {
    this.stopIrcRecycle();
    this.ircRecycleTimer = setTimeout(() => {
      this.ircRecycleTimer = null;
      if (this.socket !== armedSocket) return; // armed-for socket is gone — never touch its replacement
      try {
        armedSocket.close(1000, 'recycle');
      } catch {}
    }, IRC_RECYCLE_MS);
  }

  stopIrcRecycle() {
    if (this.ircRecycleTimer) {
      clearTimeout(this.ircRecycleTimer);
      this.ircRecycleTimer = null;
    }
  }

  async scheduleWatchdog() {
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  async scheduleIdleDisconnect() {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_DISCONNECT_MS);
  }

  async alarm() {
    // Logged unconditionally, before any branch — this is what makes the
    // "watchdog fired with zero clients" class of anomaly attributable next
    // time, instead of a bare unexplained alarm timestamp.
    let action = 'noop';
    try {
      if (this.clients.size === 0) {
        action = 'idle-teardown';
        if (this.socket) {
          try {
            this.socket.close();
          } catch {}
          this.socket = null;
          this.socketOpen = false;
          // Nulling this.socket means the pending close/error event fails
          // handleSocketDown's instance guard — its connecting=false reset
          // never runs, so reset here or a socket closed mid-CONNECT latches
          // `connecting` true and wedges every future reconnect attempt.
          // Same reasoning for the keepalive timer: handleSocketDown's own
          // stopIrcKeepalive() call never runs for this instance, so it's
          // stopped here or it keeps firing against a null socket forever.
          this.connecting = false;
          this.stopIrcKeepalive();
          this.stopIrcRecycle();
        }
        // Belt-and-suspenders: normally the SSE stream's cancel() already
        // stopped this when the last client left, but a client removed via
        // the enqueue-catch path in enqueueBytes() bypasses
        // cancel() — without this, the interval pins the DO awake forever.
        // The heartbeat-tick reap (reapDeadClients) is the primary fix for a
        // zombie client keeping clients.size > 0 so this branch is reached at
        // all; this remains the belt for the case where it's already 0.
        this.stopHeartbeat();
        // DO may evict right after this returns — await so the tail isn't lost.
        await this.flushCapture();
        return;
      }
      if (!this.socketOpen && !this.connecting) {
        action = 'reconnect';
        // new WebSocket(...) can throw synchronously (e.g. bad state) — never
        // let that skip the reschedule below, or the watchdog chain dies.
        try {
          this.ensureTwitchConnected();
        } catch (err) {
          console.error('ensureTwitchConnected threw in alarm()', err);
        }
      } else if (this.socketOpen && Date.now() - this.lastSeen.tw > IRC_SILENCE_MS) {
        // Socket looks open but nothing has arrived (not even a Twitch PING) in
        // a long time — force-close so handleSocketDown()'s backoff reconnects.
        action = 'silence-close';
        try {
          this.socket?.close();
        } catch {}
      }
      await this.flushCapture();
    } finally {
      console.log(JSON.stringify({ ev: 'alarm', clients: this.clients.size, socketOpen: this.socketOpen, connecting: this.connecting, action }));
      // Piggybacked on this same cadence rather than a new alarm slot — fires
      // on every watchdog tick while clients are attached, plus once more on
      // idle-teardown (the tail end of a stream), which is exactly when a
      // final "here's the total" line matters most.
      this.maybeLogDelayRollup();
      if (this.clients.size > 0) await this.scheduleWatchdog();
    }
  }

  // Change-gated (only logs when the cumulative totals actually moved since
  // the last rollup — a quiet stretch between ingests must never spam an
  // unchanged line) periodic summary of the ingest-tail delay accumulators.
  // Wrapped in its own try/catch with an
  // error-once flag, same shape as pollTwitchViewers/pollTwitchFollowers —
  // this is pure arithmetic over already-computed instance state, so a throw
  // here would be a bug in this method itself, and must never take down the
  // watchdog/reconnect logic in alarm() around it.
  maybeLogDelayRollup() {
    try {
      const snapshot = {
        totalMs: this.delayTotalMs,
        over1s: this.delayOver1s,
        over5s: this.delayOver5s,
        over10s: this.delayOver10s,
        attributedMs: this.delayAttributedMs,
        unattributedMs: this.delayUnattributedMs,
      };
      const prev = this._delayLastRolledUp;
      const changed = !prev || Object.keys(snapshot).some((k) => snapshot[k] !== prev[k]);
      if (!changed) return;
      this._delayLastRolledUp = snapshot;
      console.log(JSON.stringify({
        ev: 'ingest_delay_rollup',
        total_delay_s: Math.round((snapshot.totalMs / 1000) * 100) / 100,
        over_1s: snapshot.over1s,
        over_5s: snapshot.over5s,
        over_10s: snapshot.over10s,
        attributed_ms: snapshot.attributedMs,
        unattributed_ms: snapshot.unattributedMs,
      }));
      this._delayRollupErrored = false;
    } catch (err) {
      if (!this._delayRollupErrored) {
        this._delayRollupErrored = true;
        console.error(JSON.stringify({ ev: 'ingest_delay_rollup_failed', err: String(err) }));
      }
    }
  }

  ensureTwitchConnected() {
    if (this.socketOpen || this.connecting) return;
    this.connecting = true;
    let ws;
    try {
      ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    } catch (err) {
      // A synchronous constructor throw must never leave `connecting` stuck
      // true — that would wedge every future watchdog/reconnect attempt.
      this.connecting = false;
      console.error('new WebSocket threw in ensureTwitchConnected', err);
      return;
    }
    this.socket = ws;
    // Per-connection lifetime id — threads through every log line for this
    // socket so a reconnect storm is attributable to one connection vs many.
    const connId = crypto.randomUUID().slice(0, 8);
    this.connId = connId;
    ws.addEventListener('open', () => {
      const isReconnect = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      this.connecting = false;
      this.socketOpen = true;
      this.reconnectDelay = 1000;
      this.lastSeen.tw = Date.now();
      this.roomStateInit = false; // next ROOMSTATE is a fresh full-state burst — swallow it
      this.startIrcKeepalive();
      this.startIrcRecycle(ws);
      console.log(JSON.stringify({ ev: 'tw_open', connId, reconnect: isReconnect }));
      const nick = `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`NICK ${nick}`);
      ws.send(`JOIN #${this.env.TWITCH_CHANNEL}`);
      if (isReconnect) this.recoverGap(); // fire-and-forget: must never delay/block the reconnect
    });
    ws.addEventListener('message', (evt) => this.handleIrcData(evt.data));
    ws.addEventListener('close', (e) => this.handleSocketDown(ws, e));
    ws.addEventListener('error', () => this.handleSocketDown(ws, null));
  }

  async handleSocketDown(ws, event) {
    // Twitch fires both close and error on a drop — the guard below is keyed
    // on the specific socket instance, so it self-resets on every reconnect
    // (a fresh `ws` is bound in ensureTwitchConnected each time) instead of
    // latching permanently.
    if (ws && this.socket !== ws) return; // already handled by the other event
    // Log which fired: close carries the code/reason (network drop vs Twitch
    // shutdown), error does not. Whichever wins the instance guard logs once.
    if (event) {
      console.log(JSON.stringify({ ev: 'tw_close', connId: this.connId, code: event.code, reason: event.reason || '', wasClean: event.wasClean }));
    } else {
      console.log(JSON.stringify({ ev: 'tw_error', connId: this.connId }));
    }
    this.socket = null;
    this.socketOpen = false;
    this.connecting = false;
    this.stopIrcKeepalive();
    this.stopIrcRecycle();
    // DO may evict right after a socket drop — await so the tail isn't lost.
    await this.flushCapture();
    if (this.clients.size === 0) return; // nobody watching, don't reconnect
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.ensureTwitchConnected(), delay);
  }

  handleIrcData(raw) {
    this.lastSeen.tw = Date.now(); // any inbound line (incl. Twitch's own PING) proves the socket is alive
    const lines = String(raw).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('PING')) {
        this.socket?.send(line.replace('PING', 'PONG'));
        continue;
      }
      if (isReconnectCommand(line)) {
        // Twitch is retiring this edge; close and let the existing backoff
        // path in handleSocketDown() reconnect us. Logged distinctly from a
        // network drop — handleSocketDown's tw_close will follow with
        // wasClean:true for this instance.
        console.log(JSON.stringify({ ev: 'tw_reconnect_cmd', connId: this.connId }));
        try {
          this.socket?.close();
        } catch {}
        continue;
      }
      // Tags are parsed at most once per line here and threaded into every
      // parser/ircMeta call below — previously parsePrivmsg, a failed-then-
      // retried parseUsernotice, and ircMeta each independently re-ran
      // parseIrcTags on the same "@tag1=...;tag2=..." prefix (up to 3 full
      // passes for a single USERNOTICE line, the hottest path in the DO).
      const tagsSpaceIdx = line.startsWith('@') ? line.indexOf(' ') : -1;
      const lineTags = tagsSpaceIdx > 0 ? parseIrcTags(line.slice(0, tagsSpaceIdx)) : {};
      const privmsg = parsePrivmsg(line, lineTags);
      // Rider: sharedchatnotice (Twitch Shared Chat) wraps another USERNOTICE
      // msg-id — parseUsernotice below never claims it (not in
      // USERNOTICE_KIND/USERNOTICE_SYS), so it already falls through to the
      // generic capture sink at the bottom of this loop untouched. This just
      // logs the inner msg-id (source-msg-id) so a real occurrence is
      // greppable without downloading the capture object. Log-only — no
      // extra pushCapture call here, no rendering, no classification change.
      if (lineTags['msg-id'] === 'sharedchatnotice') {
        console.log(JSON.stringify({ ev: 'shared_chat_notice_capture', innerMsgId: lineTags['source-msg-id'] || null }));
      }
      if (privmsg) {
        // Every PRIVMSG pushes normally first — ring, recentTwitchIds,
        // lastTwTmiSentTs, SSE broadcast all fire exactly as for any other
        // message, gap-recovery-consistent by construction (a suppressed
        // row's id is already in recentTwitchIds, so recoverGap can never
        // resurrect it — see filterRecoveredMessages' seenIds check).
        // Gigantify double-display suppression, EventSub-first order — see
        // consumePendingGigantify/handleGigantifyDedupe. Only ever consumes
        // a pending entry this PRIVMSG's own login+text actually matches; a
        // hit supersedes the just-pushed row via the same markSuperseded
        // path handleGigantifyDedupe's IRC-first branch uses — one
        // suppression mechanism, two triggers.
        const pushed = this.pushMessage('tw', privmsg, ircMeta(line, lineTags));
        const pendingHit = this.consumePendingGigantify(pushed.login, pushed.text, pushed.emotes);
        if (pendingHit) {
          this.markSuperseded(pushed, {
            order: 'eventsub_first',
            emoteName: pendingHit.emoteName,
            emoteId: pendingHit.emoteId,
            pendingTs: pendingHit.ts,
          });
        }
        continue;
      }
      const usernotice = parseUsernotice(line, lineTags);
      if (usernotice) {
        this.pushMessage('tw', usernotice, ircMeta(line, lineTags));
        continue;
      }
      const clearmsg = parseClearmsg(line);
      if (clearmsg) {
        this.applyClearmsg(clearmsg);
        continue;
      }
      const clearchat = parseClearchat(line);
      if (clearchat) {
        this.applyClearchat(clearchat);
        continue;
      }
      const roomstate = parseRoomstate(line);
      if (roomstate) {
        this.applyRoomstate(roomstate);
        continue;
      }
      // Everything else recognized-but-unhandled or unrecognized: capture as
      // untrusted data, never interpreted as instructions. PING/RECONNECT
      // already `continue`d above; isProtocolNoise excludes connection scaffolding.
      if (!isProtocolNoise(line)) this.pushCapture(line);
    }
  }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────

export function parseIrcTags(raw) {
  const tags = {};
  if (!raw || raw[0] !== '@') return tags;
  for (const pair of raw.slice(1).split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
  }
  return tags;
}

// Single left-to-right scan per IRCv3 tag-escaping rules: a chained-regex
// unescape misparses an escaped backslash immediately followed by a plain
// "s"/"r"/"n"/":" char (the first replace consumes the trailing backslash
// of the pair plus that next char, corrupting it). Scanning sequentially
// and consuming exactly one escape at a time avoids that.
function unescapeTagValue(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      const next = v[++i];
      if (next === 's') out += ' ';
      else if (next === ':') out += ';';
      else if (next === 'r') out += '\r';
      else if (next === 'n') out += '\n';
      else if (next === '\\') out += '\\';
      else out += next; // unrecognized escape: drop the backslash
    } else {
      out += v[i];
    }
  }
  return out;
}

// badges tag is a comma-separated "id/version" list, e.g. "broadcaster/1,founder/0"
function hasBadge(tags, badgeId) {
  const badges = tags.badges || '';
  return badges.split(',').some((b) => b.split('/')[0] === badgeId);
}

function badgeFlags(tags) {
  const isMod = tags.mod === '1' || hasBadge(tags, 'broadcaster');
  // founder/VIP badges are deliberately excluded — role color is mod (blue,
  // includes broadcaster) or paid-member (green, subscriber tag only). VIPs
  // and founders (unless independently subscribed) get default text color.
  const isMember = tags.subscriber === '1';
  return {
    ...(isMod ? { isMod: true } : {}),
    ...(isMember ? { isMember: true } : {}),
  };
}

// Common IRC line preamble shared by every line-type parser below: an
// optional "@tags " prefix, then either a ":<source> COMMAND params" line
// or (Twitch's own PING) a bare "COMMAND params" line with no source
// prefix. Was duplicated ×7 (parsePrivmsg/parseUsernotice/parseClearmsg/
// parseClearchat/parseRoomstate/isReconnectCommand/isProtocolNoise) — per an
// internal code review (2026-07-31), finding B1-full. Returns null only when the line
// doesn't parse far enough to identify a command; each call site applies
// its own further requirements (hasPrefix, a specific command, tags
// presence) on top. preParsedTags lets a caller that already parsed this
// line's tags (handleIrcData) skip a second full parseIrcTags pass — same
// opt-in reuse parsePrivmsg/parseUsernotice already had individually
// (only consulted when the line actually carries an '@tags' prefix, same
// as before).
export function splitIrcLine(line, preParsedTags) {
  let rest = line;
  let tags = {};
  if (rest.startsWith('@')) {
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) return null;
    tags = preParsedTags || parseIrcTags(rest.slice(0, spaceIdx));
    rest = rest.slice(spaceIdx + 1);
  }
  const hasPrefix = rest.startsWith(':');
  let source = '';
  let afterPrefix = rest;
  if (hasPrefix) {
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) return null;
    source = rest.slice(1, spaceIdx);
    afterPrefix = rest.slice(spaceIdx + 1);
  }
  const cmdSpaceIdx = afterPrefix.indexOf(' ');
  const command = cmdSpaceIdx === -1 ? afterPrefix : afterPrefix.slice(0, cmdSpaceIdx);
  const params = cmdSpaceIdx === -1 ? '' : afterPrefix.slice(cmdSpaceIdx + 1);
  return { tags, hasPrefix, source, command, params };
}

// preParsedTags: see splitIrcLine's comment above — same opt-in reuse.
export function parsePrivmsg(line, preParsedTags) {
  const split = splitIrcLine(line, preParsedTags);
  if (!split || !split.hasPrefix || split.command !== 'PRIVMSG') return null;
  const { tags, source, params } = split;
  const colonIdx = params.indexOf(' :');
  if (colonIdx === -1) return null;
  const text = params.slice(colonIdx + 2);
  if (!text) return null;
  const nick = source.split('!')[0];
  const login = nick; // IRC prefix nick IS the lowercase login for Twitch chat
  const user = tags['display-name'] || nick;
  const extra = tags.bits ? { kind: 'cheer', amount: `${tags.bits} bits` } : {};
  const emotes = parseEmotes(tags.emotes);
  const gifs = sanitizeGifs(parseGifs(tags.gifs, [...text].length));
  return {
    user,
    login,
    text,
    ...extra,
    ...badgeFlags(tags),
    ...(tags['first-msg'] === '1' ? { firstMsg: true } : {}),
    ...(emotes.length ? { emotes } : {}),
    ...(gifs.length ? { gifs } : {}),
  };
}

// Twitch's emotes tag: "emoteId:start-end,start-end/emoteId:start-end/…".
// Offsets are Unicode code-point indices into the message text. end is
// INCLUSIVE per Twitch's wire format — callers slicing a range must use
// end+1 as the exclusive bound (off-by-one here silently truncates the last
// character of every final-token emote).
export function parseEmotes(tag) {
  if (!tag) return [];
  const out = [];
  for (const part of tag.split('/')) {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) continue;
    const id = part.slice(0, colonIdx);
    const ranges = part.slice(colonIdx + 1);
    if (!id || !ranges) continue;
    for (const range of ranges.split(',')) {
      const dashIdx = range.indexOf('-');
      if (dashIdx === -1) continue;
      const start = Number(range.slice(0, dashIdx));
      const end = Number(range.slice(dashIdx + 1));
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) continue;
      out.push({ id, start, end });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Twitch's gifs tag (docs dated 2026-07-31):
// "start-end|gifID|gifURL[,start-end|gifID|gifURL...]". Offsets are
// Unicode code-point indices into the message text, end INCLUSIVE (same
// convention as emotes above) — the range covers the whole bracketed
// alt-text body. textLength is the code-point length of the PRIVMSG body
// (caller passes [...text].length), needed to reject a range past the end
// of the message. Structurally invalid entries are dropped outright — a
// buggy/spoofed source must never hand the client's [...text] walker an
// offset it can't trust — with a single gif_parse_skip log per message
// (reason only, never the URL) regardless of how many entries in that
// message were malformed.
export function parseGifs(tag, textLength) {
  if (!tag) return [];
  const out = [];
  let loggedSkip = false;
  for (const part of tag.split(',')) {
    const reason = pushGifEntry(part, textLength, out);
    if (reason && !loggedSkip) {
      loggedSkip = true;
      console.log(JSON.stringify({ ev: 'gif_parse_skip', reason }));
    }
  }
  return out;
}

// Returns a skip reason string, or null on success (entry pushed to out).
function pushGifEntry(part, textLength, out) {
  const firstPipe = part.indexOf('|');
  if (firstPipe === -1) return 'missing_parts';
  const secondPipe = part.indexOf('|', firstPipe + 1);
  if (secondPipe === -1) return 'missing_parts';
  const range = part.slice(0, firstPipe);
  const id = part.slice(firstPipe + 1, secondPipe);
  const url = part.slice(secondPipe + 1);
  if (!id || !url) return 'missing_parts';
  const dashIdx = range.indexOf('-');
  if (dashIdx === -1) return 'non_numeric_range';
  const start = Number(range.slice(0, dashIdx));
  const end = Number(range.slice(dashIdx + 1));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) return 'non_numeric_range';
  if (end < start) return 'end_before_start';
  if (end >= textLength) return 'range_out_of_bounds';
  out.push({ start, end, id, url });
  return null;
}

// Authoritative (worker-side) allowlist for Twitch GIF image hosts — same
// shape as isAllowedEmojiHost below for YouTube. https only, host must be
// exactly "media<N>.giphy.com" (N optional) — a suffix/prefix trick like
// "evil.giphy.com.attacker.example" or "media.giphy.com.evil.example" must
// never match. Docs say the URL must be rendered exactly as given, never
// modified — this only decides accept/reject, never rewrites the string.
const GIF_HOST_RE = /^media\d*\.giphy\.com$/;

function isAllowedGifHost(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    return GIF_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

// Host-validates each structurally-valid gif entry from parseGifs. Reject ->
// keep the entry (client still renders the bracketed alt text) but drop the
// url; log gif_host_rejected {host} (host only, never full URL). Accept ->
// log gif_host_accepted {host}, unsampled (unlike the YouTube emoji
// accept-log, which samples — GIF volume is expected to be far lower).
function sanitizeGifs(gifs) {
  const out = [];
  for (const g of gifs) {
    const entry = { start: g.start, end: g.end, id: g.id };
    let host = null;
    try { host = new URL(g.url).hostname; } catch { /* leave null */ }
    if (isAllowedGifHost(g.url)) {
      entry.url = g.url;
      console.log(JSON.stringify({ ev: 'gif_host_accepted', host }));
    } else {
      console.log(JSON.stringify({ ev: 'gif_host_rejected', host }));
    }
    out.push(entry);
  }
  return out;
}

const USERNOTICE_KIND = {
  sub: 'sub',
  resub: 'sub',
  subgift: 'giftsub',
  submysterygift: 'giftsub',
  giftpaidupgrade: 'giftsub',
  anongiftpaidupgrade: 'giftsub',
};

// raid/announcement/viewermilestone render as gray info rows (sys), never
// gold/.paid like subs.
const USERNOTICE_SYS = {
  raid: 'raid',
  announcement: 'announce',
  viewermilestone: 'viewermilestone',
};

// preParsedTags: see splitIrcLine's comment above — same opt-in reuse.
export function parseUsernotice(line, preParsedTags) {
  const split = splitIrcLine(line, preParsedTags);
  if (!split || !split.hasPrefix || split.command !== 'USERNOTICE') return null;
  const { tags, params } = split;
  const msgId = tags['msg-id'];
  const colonIdx = params.indexOf(' :');
  const trailingText = colonIdx !== -1 ? params.slice(colonIdx + 2) : '';
  const login = tags.login || undefined;
  const user = tags['display-name'] || tags.login || 'unknown';

  const sys = USERNOTICE_SYS[msgId];
  if (sys === 'raid') {
    const raiderLogin = tags['msg-param-login'] || login;
    const raiderName = tags['msg-param-displayName'] || user;
    const viewers = tags['msg-param-viewerCount'];
    const text = viewers
      ? `${raiderName} raiding with ${viewers} viewers`
      : tags['system-msg'] || `${raiderName} is raiding`;
    return { user: raiderName, login: raiderLogin, sys: 'raid', text, ...badgeFlags(tags) };
  }
  if (sys === 'announce') {
    return { user, login, sys: 'announce', text: trailingText || tags['system-msg'] || '', ...badgeFlags(tags) };
  }
  if (sys === 'viewermilestone') {
    // msg-param-category is always 'watch-streak' in observed data (see
    // PR #38's 2026-08-08 streak coverage audit) — rendered unconditionally
    // rather than filtered on category, since system-msg already carries a
    // complete, correct sentence for any category Twitch might send.
    return { user, login, sys: 'viewermilestone', text: tags['system-msg'] || '', ...badgeFlags(tags) };
  }

  const kind = USERNOTICE_KIND[msgId];
  if (!kind) return null;
  let text = tags['system-msg'] || '';
  if (msgId === 'resub' && trailingText) text += ` — ${trailingText}`;
  if (msgId === 'resub') {
    // Raw ground truth, logged BEFORE parseStreakMonths/parseShouldShareStreak
    // below do any interpretation — catches Twitch sending an unexpected raw
    // value (non-numeric streak-months, an unfamiliar should-share-streak
    // string, etc.) that the parsed fields would otherwise silently absorb
    // into undefined/fail-open. Not sampled: resub USERNOTICEs are rare
    // relative to chat volume, unlike the per-message paths elsewhere in
    // this file that do need sampling.
    console.log(JSON.stringify({
      ev: 'tw_resub_streak_raw',
      login: login || null,
      rawStreakMonths: tags['msg-param-streak-months'] ?? null,
      rawShouldShareStreak: tags['msg-param-should-share-streak'] ?? null,
    }));
    const streakInfo = formatResubStreakInfo(tags);
    if (streakInfo) text += ` ${streakInfo}`;
  }
  const giftAmount = msgId === 'submysterygift' ? giftCountAmount(tags, text) : undefined;
  // streakMonths is structured (not parsed back out of `text`) so the TTS path
  // (formatUtterance) never has to read msg.text — same tag, two independent
  // consumers: display renders the formatted "(N months, M-month streak)"
  // string, TTS speaks the raw number only when >= 2 (see formatUtterance).
  const streakMonths = msgId === 'resub' ? parseStreakMonths(tags) : undefined;
  const shouldShareStreak = msgId === 'resub' ? parseShouldShareStreak(tags) : undefined;
  const extra = {
    ...(giftAmount ? { amount: giftAmount } : {}),
    ...(streakMonths !== undefined ? { streakMonths } : {}),
    ...(shouldShareStreak !== undefined ? { shouldShareStreak } : {}),
  };
  return { user, login, kind, text, ...extra, ...badgeFlags(tags) };
}

// Twitch zeroes/omits msg-param-streak-months when the user hides their
// streak (msg-param-should-share-streak=0) — undefined here covers both
// "tag absent" and "non-numeric", 0 covers "present but hidden". Callers
// that only want the display sentence's segment already guard on > 0.
function parseStreakMonths(tags) {
  const streak = Number(tags['msg-param-streak-months']);
  return Number.isFinite(streak) ? streak : undefined;
}

// msg-param-streak-months can still arrive nonzero even when the user hid
// their streak (observed live — Twitch doesn't always zero the tag itself,
// see PR #43 review), so formatUtterance can't trust streakMonths alone.
// This tag is the actual hide signal: present-and-'0' means hidden — speak
// nothing. Absent (older/rare clients) or any other value defaults to shown,
// same fail-open posture as the rest of this parser.
function parseShouldShareStreak(tags) {
  const raw = tags['msg-param-should-share-streak'];
  if (raw === undefined) return undefined;
  return raw !== '0';
}

// Twitch sends msg-param-cumulative-months (always) and msg-param-streak-months
// (only when msg-param-should-share-streak=1) as separate numeric USERNOTICE
// tags on every resub. Read directly here rather than relying on Twitch's
// system-msg wording, which silently drops the streak sentence if Twitch ever
// changes the copy (see PR #38's 2026-08-08 streak coverage audit). Absent/zero/
// non-numeric tags omit that segment — fail-open, never throws, never blocks
// the gold row.
function formatResubStreakInfo(tags) {
  const cumulative = Number(tags['msg-param-cumulative-months']);
  const streak = parseStreakMonths(tags);
  const parts = [];
  if (Number.isFinite(cumulative) && cumulative > 0) parts.push(`${cumulative} months`);
  if (streak > 0) parts.push(`${streak}-month streak`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

// submysterygift's gift count: prefer Twitch's own msg-param-mass-gift-count
// tag over parsing system-msg text — the tag is exact, always sent by real
// Twitch clients. The regex fallback (comma-aware — a plain /\d+/ would
// truncate "1,000" to "1") only covers a client that omits the tag.
function giftCountAmount(tags, systemMsg) {
  const tagCount = Number(tags['msg-param-mass-gift-count']);
  if (Number.isFinite(tagCount) && tagCount > 0) {
    return tagCount === 1 ? '1 gift' : `${tagCount} gifts`;
  }
  // Anchored to "gifting <N>" rather than a bare digit-scan — a display name
  // containing a digit (e.g. "TWW2") would otherwise match before the real
  // count.
  const match = systemMsg.match(/gifting\s+(\d[\d,]*)/i);
  const n = match ? Number(match[1].replace(/,/g, '')) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n === 1 ? '1 gift' : `${n} gifts`;
}

// Twitch is retiring one WS edge and sends ":tmi.twitch.tv RECONNECT" to
// warn clients to reconnect elsewhere before it drops them.
export function isReconnectCommand(line) {
  const split = splitIrcLine(line);
  return Boolean(split) && split.hasPrefix && split.command === 'RECONNECT';
}

// @login=<author>;target-msg-id=<id> :tmi.twitch.tv CLEARMSG #chan :<deleted text>
export function parseClearmsg(line) {
  const split = splitIrcLine(line);
  if (!split || !split.hasPrefix || split.command !== 'CLEARMSG') return null;
  const { tags } = split;
  const login = tags.login;
  const targetId = tags['target-msg-id'];
  if (!login || !targetId) return null;
  return { login, targetId };
}

// Timeout/ban: ":tmi.twitch.tv CLEARCHAT #chan :<login>", `ban-duration` tag
// present ⇒ timeout (seconds), absent ⇒ ban. Bare clear (no trailing target,
// the "clear chat" button): ":tmi.twitch.tv CLEARCHAT #chan" — never marks
// rows, the feed is never wiped.
export function parseClearchat(line) {
  const split = splitIrcLine(line);
  if (!split || !split.hasPrefix || split.command !== 'CLEARCHAT') return null;
  const { tags, params } = split;
  const colonIdx = params.indexOf(' :');
  if (colonIdx === -1) return { clear: true };
  const login = params.slice(colonIdx + 2);
  if (!login) return { clear: true };
  const durTag = tags['ban-duration'];
  const seconds = durTag != null ? Number(durTag) : null;
  return { login, seconds: Number.isFinite(seconds) ? seconds : null };
}

// ROOMSTATE deltas: Twitch sends every tag on the initial post-JOIN burst,
// then only the changed tag(s) on subsequent updates — so this reports
// whatever is present in *this* line, nothing more. Semantics per tag:
// slow: seconds, 0 = off. subs-only/emote-only/r9k(unique-chat): 0/1.
// followers-only: -1 = off, 0 = on/any-follower, N>0 = on/N-minutes.
export function parseRoomstate(line) {
  if (!line.startsWith('@')) return null; // ROOMSTATE always carries tags — stricter than splitIrcLine's own optional-tags tolerance
  const split = splitIrcLine(line);
  if (!split || !split.hasPrefix || split.command !== 'ROOMSTATE') return null;
  const { tags } = split;

  const out = {};
  if (tags.slow !== undefined) {
    const n = Number(tags.slow);
    out.slow = n > 0 ? `slow mode on: ${n}s` : 'slow mode off';
  }
  if (tags['subs-only'] !== undefined) {
    out.subsOnly = tags['subs-only'] === '1' ? 'sub-only on' : 'sub-only off';
  }
  if (tags['emote-only'] !== undefined) {
    out.emoteOnly = tags['emote-only'] === '1' ? 'emote-only on' : 'emote-only off';
  }
  if (tags['followers-only'] !== undefined) {
    const n = Number(tags['followers-only']);
    out.followersOnly = n < 0 ? 'followers-only off' : n === 0 ? 'followers-only on' : `followers-only on: ${n}m`;
  }
  if (tags.r9k !== undefined) {
    out.uniqueChat = tags.r9k === '1' ? 'unique-chat on' : 'unique-chat off';
  }
  return Object.keys(out).length ? out : null;
}

// Connection/membership scaffolding we deliberately never capture, even
// though it isn't otherwise parsed: numeric welcome replies, CAP ack, JOIN/
// PART, USERSTATE/GLOBALUSERSTATE. PING/PONG/RECONNECT are handled earlier
// in handleIrcData and never reach this check; listed here for completeness
// so this stays a pure, directly-testable function.
const PROTOCOL_NOISE_COMMANDS = new Set([
  '001', '002', '003', '004', '353', '366', '372', '375', '376',
  'CAP', 'JOIN', 'PART', 'USERSTATE', 'GLOBALUSERSTATE', 'PING', 'PONG', 'RECONNECT',
]);

export function isProtocolNoise(line) {
  const split = splitIrcLine(line);
  if (!split) return false;
  return PROTOCOL_NOISE_COMMANDS.has(split.command);
}

// Twitch's own message id + send-ts, for gap-recovery dedup/ordering — kept
// separate from parsePrivmsg/parseUsernotice since the SSE feed never needs
// them. preParsedTags: see parsePrivmsg's comment — same opt-in reuse.
function ircMeta(line, preParsedTags) {
  if (!line.startsWith('@')) return {};
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) return {};
  const tags = preParsedTags || parseIrcTags(line.slice(0, spaceIdx));
  const ts = Number(tags['tmi-sent-ts']);
  return { id: tags.id, ts: Number.isFinite(ts) ? ts : undefined };
}

// Shared shape for every count field in buildStatusPayload's `counts` block —
// {v, stale}. value/at are whatever the DO last recorded (v:null when never
// seen); staleness is computed fresh on every status broadcast rather than
// stored, so it can never drift from "now". A stale count keeps its last v —
// the client dims it rather than blanking it (never lie by going silent AND
// never lie by looking fresh).
export function countField(value, at, staleMs, now) {
  if (value == null || !at) return { v: null, stale: false };
  return { v: value, stale: now - at > staleMs };
}

// FIFO-bounded Set insert, shared by both platforms' dedupe guards
// (recentTwitchIds, recentYtIds). Re-adding an existing value is a no-op —
// native Set semantics don't reorder it, so it doesn't get a fresh eviction
// slot; that's fine, dedupe only cares about presence.
export function addToBoundedSet(set, value, maxSize) {
  set.add(value);
  if (set.size > maxSize) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

// Same bound-eviction shape as addToBoundedSet, for key->timestamp maps
// (pendingYtDeletes/pendingAuthorDeletes) — oldest-inserted key evicted first.
export function addToBoundedMap(map, key, value, maxSize) {
  map.set(key, value);
  if (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

// Filters + orders recent-messages.robotty.de replay lines for gap recovery.
// Reuses parsePrivmsg/parseUsernotice — no second parser. cutoffTs/floorTs
// are Twitch tmi-sent-ts values (ms); seenIds guards against messages the
// live socket already delivered before the fetch resolved.
const RECOVERED_EMOTES_MAX = 64;
// A single Twitch message can't realistically carry many gif entries in
// practice (docs' own wire format spends a whole message body per gif) —
// far lower ceiling than emotes. Same truncation shape, closes FASTFOLLOW #7.
const RECOVERED_GIFS_MAX = 8;

export function filterRecoveredMessages(lines, { cutoffTs, floorTs, seenIds }) {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  const recovered = [];
  for (const line of lines) {
    if (typeof line !== 'string' || !line.startsWith('@')) continue;
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const tags = parseIrcTags(line.slice(0, spaceIdx));
    const ts = Number(tags['tmi-sent-ts']);
    if (!Number.isFinite(ts) || ts <= cutoffTs || ts < floorTs) continue;
    const twId = tags.id;
    if (twId && seen.has(twId)) continue;
    const parsed = parsePrivmsg(line) || parseUsernotice(line);
    if (!parsed) continue;
    const data = { ...parsed, recovered: true };
    if (data.emotes && data.emotes.length > RECOVERED_EMOTES_MAX) {
      data.emotes = data.emotes.slice(0, RECOVERED_EMOTES_MAX);
    }
    if (data.gifs && data.gifs.length > RECOVERED_GIFS_MAX) {
      data.gifs = data.gifs.slice(0, RECOVERED_GIFS_MAX);
    }
    recovered.push({ ts, twId, data });
  }
  recovered.sort((a, b) => a.ts - b.ts);
  return recovered;
}

// Authoritative (worker-side) allowlist for YouTube emoji image hosts.
// ggpht.com/googleusercontent.com serve member-custom emoji; gstatic.com
// serves YouTube's own globally-supported (non-member) emoji images — added
// alongside the class (b) fix in normalize.mjs (PR #40, internal audit
// 2026-08-08), per the vendored lib's fixture shape. Unconfirmed against live traffic —
// emoji_host_rejected logging (below) is the safety net if real gstatic
// paths differ or YT serves class (b) from a host not yet seen here.
// ytimg.com is deliberately excluded: it's thumbnails, never chat emojis, in
// this field. https only. A rejected host degrades (url blanked, alt/
// shortcode still renders) rather than dropping the message — see
// normalizeYt below.
// Sampling rate for emoji_host_accepted below — mirrors the poller's
// GLOBAL_EMOJI_LOG_SAMPLE_RATE (normalize.mjs). This is the accept-path
// counterpart to emoji_host_rejected: audit round 2026-08-20 could only
// prove zero *rejections* in a window, never that the gstatic
// (/youtube/img/emojis/) positive path was actually exercised — needed to
// clear the #51 HOLD. Same volume reasoning as the poller's sampled log:
// this fires on every accepted emoji entry during an active stream, so full
// logging would be noise; 2% is enough to see the host distribution.
const EMOJI_HOST_ACCEPTED_LOG_SAMPLE_RATE = 0.02;

function isAllowedEmojiHost(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname;
    return host === 'ggpht.com' || host.endsWith('.ggpht.com')
      || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com')
      || host === 'gstatic.com' || host.endsWith('.gstatic.com');
  } catch {
    return false;
  }
}

// Validates+cleans an incoming emotes array against `text` (already
// length-capped). Two distinct failure modes, deliberately different outcomes:
//   - structurally invalid (bad types, out-of-range/overlapping/unsorted
//     offsets) -> the WHOLE ENTRY IS DROPPED. A buggy/compromised poller must
//     never hand the client's [...text] walker an offset it can't trust.
//   - valid offsets but a disallowed image host -> DEGRADE: keep the entry
//     (alt/shortcode still renders as text) but blank the url, and log the
//     rejected host (never the full URL) so a real YouTube CDN move shows up
//     as a log pattern instead of emoji silently degrading forever.
// Entries must arrive sorted by start and non-overlapping; an entry that
// isn't strictly after the previous kept entry is dropped, not reordered.
function sanitizeYtEmotes(emotes, text) {
  if (!Array.isArray(emotes)) return undefined;
  const textLen = [...text].length;
  const cleaned = [];
  let lastEnd = -1;
  for (const e of emotes) {
    if (!e || typeof e !== 'object') continue;
    const { start, end, url, alt } = e;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end < start || end >= textLen) continue;
    if (start <= lastEnd) continue; // unsorted or overlapping vs. last kept entry
    const entry = { start, end };
    if (typeof alt === 'string' && alt) entry.alt = alt.length > 64 ? alt.slice(0, 64) : alt;
    if (typeof url === 'string' && url) {
      if (isAllowedEmojiHost(url)) {
        entry.url = url;
        if (Math.random() < EMOJI_HOST_ACCEPTED_LOG_SAMPLE_RATE) {
          let host = null;
          try { host = new URL(url).hostname; } catch { /* leave null */ }
          console.log(JSON.stringify({ ev: 'emoji_host_accepted', host }));
        }
      } else {
        let host = null;
        try { host = new URL(url).hostname; } catch { /* leave null */ }
        console.log(JSON.stringify({ ev: 'emoji_host_rejected', host }));
      }
    }
    cleaned.push(entry);
    lastEnd = end;
    if (cleaned.length >= 20) break;
  }
  return cleaned.length ? cleaned : undefined;
}

export function normalizeYt(body) {
  if (!body || typeof body !== 'object') throw new Error('invalid body');
  const { user, text, color, kind, amount, isMod, isMember, ytId, recovered, emotes, authorId } = body;
  if (typeof user !== 'string' || !user.trim()) throw new Error('missing user');
  if (typeof text !== 'string' || !text.trim()) throw new Error('missing text');
  const trimmedUser = user.trim();
  const out = { user: ellipsize(trimmedUser, 100), text: ellipsize(text, 500) };
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) out.color = color;
  if (typeof kind === 'string' && VALID_KINDS.has(kind)) out.kind = kind;
  if (typeof amount === 'string' && amount.trim()) {
    out.amount = ellipsize(amount, 32);
  }
  if (typeof isMod === 'boolean') out.isMod = isMod;
  if (typeof isMember === 'boolean') out.isMember = isMember;
  if (typeof ytId === 'string' && ytId.trim()) out.ytId = ytId.length > 128 ? ytId.slice(0, 128) : ytId;
  if (typeof recovered === 'boolean') out.recovered = recovered;
  if (typeof authorId === 'string' && authorId.trim()) out.authorId = authorId.length > 128 ? authorId.slice(0, 128) : authorId;
  const cleanedEmotes = sanitizeYtEmotes(emotes, out.text);
  if (cleanedEmotes) out.emotes = cleanedEmotes;
  return out;
}

// ── Twitch EventSub ──────────────────────────────────────────────────────

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Twitch's spec: HMAC-SHA256 over the exact concatenation `id + timestamp +
// rawBody` (order matters, raw bytes — never a re-serialized JSON), keyed by
// the shared secret, hex-encoded and prefixed `sha256=`. Compared against the
// Twitch-Eventsub-Message-Signature header with a constant-time comparator.
export async function verifySignature(secret, id, timestamp, rawBody, signatureHeader) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  const digest = await hmacSha256Hex(secret, `${id}${timestamp}${rawBody}`);
  return safeEqual(`sha256=${digest}`, signatureHeader);
}

// Replay guard: reject notifications whose Twitch-Eventsub-Message-Timestamp
// is older than maxAgeMs. An unparseable timestamp is treated as stale —
// fail closed, never treated as fresh.
export function isStale(timestampStr, now, maxAgeMs) {
  const ts = Date.parse(timestampStr);
  if (!Number.isFinite(ts)) return true;
  return now - ts > maxAgeMs;
}

// The desired EventSub subscription set. Deliberately excludes channel.raid —
// IRC USERNOTICE already renders raids in-band (see parseUsernotice above);
// standing rule is EventSub subscribes only to what IRC cannot see.
//
// Hype Train is pinned to v2, not v1: production rejected every v1 create
// with a 400 (found in a 2026-07-25 log audit, all night, every hourly ensure
// cycle) — Twitch's current EventSub subscription-types docs only document
// v2 request/response shapes for hype_train.begin/progress/end, confirming
// v1 is sunset. v1 was originally chosen because `twitch event trigger`
// (twitch-cli 1.1.25) can't mock v2 at all ("Invalid version given. Valid
// version(s): 1") — that CLI limitation no longer wins once production
// itself rejects v1; the committed v2 fixtures are transcribed from Twitch's
// documented example payloads instead (see test/eventsub.test.js), pending a
// real captured production notification. v1/v2 share every field
// mapEventToRow reads (level/total/progress/goal) — v2 only adds
// shared-hype-train fields (shared_train_participants, is_shared_train,
// all_time_high_*) this feature never uses, so no mapping changes were
// needed.
export function buildDesiredSubs(broadcasterId) {
  const condition = { broadcaster_user_id: broadcasterId };
  return [
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition },
    { type: 'channel.hype_train.begin', version: '2', condition },
    { type: 'channel.hype_train.progress', version: '2', condition },
    { type: 'channel.hype_train.end', version: '2', condition },
    { type: 'channel.ad_break.begin', version: '1', condition },
    { type: 'channel.bits.use', version: '1', condition },
    // channel.moderate v2 — own condition object (needs moderator_user_id,
    // the other five don't). moderator_user_id here is an authorization
    // identity (must match the granting user), not an actor filter: Twitch's
    // own docs example ("Adding a Moderator") shows a delivered event whose
    // moderator_user_id differs from the condition — see docs/ARCHITECTURE.md
    // §3a for the citation and the live-verification follow-up.
    { type: 'channel.moderate', version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
  ];
}

// Code-point truncation, never .length/.slice (UTF-16 code units) — same
// invariant as the YouTube emote start/end offsets (see docs/ARCHITECTURE.md
// §2c). .length-based slicing can cut a surrogate pair in half, corrupting
// the trailing character instead of cleanly dropping it.
function ellipsize(str, max) {
  if (typeof str !== 'string') return '';
  const codePoints = [...str];
  return codePoints.length > max ? codePoints.slice(0, max - 1).join('') + '…' : str;
}

// Rounds to the nearest unit (598s -> "10m", never floored/truncated to
// "9m") — used for channel.moderate timeout durations, derived from
// expires_at - now. Negative/non-finite input (a clock-skewed or already-
// expired expires_at) clamps to 0s rather than printing a negative duration.
function formatDuration(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// Gigantify an Emote double-display suppression — see docs/ARCHITECTURE.md
// §3a and ChatHub.handleGigantifyDedupe/consumePendingGigantify. There is no
// id correlating a channel.bits.use gigantify_an_emote event to the plain
// IRC PRIVMSG it accompanies, so the match is heuristic: same login (checked
// by the caller) + this text check + a tight time window. A real captured
// channel.chat.message payload for this exact feature (twitchdev/issues#1047)
// shows the message is NOT always just the emote — it can carry other text
// and even other emotes alongside the gigantified one — so exact-equality
// would miss real cases. A bare substring check would be too loose (e.g.
// "Kappa" inside "KappaPride" or a sentence that happens to contain the
// emote name as a word fragment) and risks eating an unrelated message from
// the same user. Token match is the middle ground: the emote name must
// appear as one whole whitespace-delimited word, exactly how Twitch emotes
// are written in chat text.
export function gigantifyTextMatches(text, emoteName) {
  if (typeof text !== 'string' || !text || typeof emoteName !== 'string' || !emoteName) return false;
  return text.split(/\s+/).includes(emoteName);
}

// Two-tier gigantify match rule for a single row (a ring entry, or the
// {text, emotes} shape of a just-pushed-but-not-yet-in-the-ring row), shared
// by selectGigantifyCandidates (IRC-first, scans the whole ring) and
// consumePendingGigantify (EventSub-first, checks one just-pushed row against
// one buffered pending entry) — one rule, two callers. Preference order: (1)
// the row's own `emotes` tag data (copied verbatim from the PRIVMSG's
// `emotes` tag) contains the gigantified emote's id — exact, can't collide on
// emote-name text; (2) only when the row carries NO emote data at all, fall
// back to gigantifyTextMatches on the emote name. A row that HAS emote data
// but no id match never falls through to the text tier — its tagged emotes
// are known and don't include this one, so a same-word text hit would be a
// real collision (e.g. a channel emote sharing a name with a global one), not
// the gigantified message (PR41 review finding R1).
export function gigantifyRowMatches(row, { emoteId, emoteName }) {
  if (Array.isArray(row.emotes) && row.emotes.length) {
    return !!emoteId && row.emotes.some((em) => em.id === emoteId);
  }
  return gigantifyTextMatches(row.text, emoteName);
}

// Ring-scan candidate filter for handleGigantifyDedupe (IRC-first order).
// Same-login, still-visible, in-window rows only, matched via
// gigantifyRowMatches. When an id-tier hit exists, only id-tier rows are
// returned (text-tier rows can never coexist with them — see
// gigantifyRowMatches — but this keeps the id-preference explicit).
export function selectGigantifyCandidates(ring, { login, emoteName, emoteId, now }) {
  const inWindow = ring.filter((e) =>
    e.platform === 'tw' && !e.kind && !e.sys && !e.deleted && !e.superseded &&
    e.login === login && now - e.ts <= GIGANTIFY_SUPPRESS_WINDOW_MS);
  if (emoteId) {
    const idHits = inWindow.filter((e) => Array.isArray(e.emotes) && e.emotes.some((em) => em.id === emoteId));
    if (idHits.length) return idHits;
  }
  return inWindow.filter((e) => gigantifyRowMatches(e, { emoteId, emoteName }) && !(e.emotes && e.emotes.length));
}

// Picks the candidate whose `twTs` (Twitch's own tmi-sent-ts, when known —
// falls back to our receipt `ts` for a recovered row that somehow lacks it)
// is closest to eventTs, the EventSub notification's own envelope timestamp
// (Twitch-Eventsub-Message-Timestamp, forwarded edge->DO as the x-es-ts
// header — see handleEventSubCallback/handleEventSub). Both are Twitch-side
// clocks, so comparing them directly is meaningful in a way our own receipt
// clock wouldn't be. `now` (DO receipt time) is deliberately NOT used here.
// Missing/unparseable eventTs short-circuits straight to the newest
// candidate (candidates is ring-ordered, oldest first). Otherwise,
// candidates is walked oldest->newest with `<=` for the "better" comparison,
// so an exact tie also resolves to the newest — both per the documented
// tie-break rule.
export function pickGigantifyCandidate(candidates, eventTs) {
  if (!candidates.length) return null;
  if (!Number.isFinite(eventTs)) return candidates[candidates.length - 1];
  let best = null;
  let bestDelta = Infinity;
  for (const c of candidates) {
    const rowTs = Number.isFinite(c.twTs) ? c.twTs : c.ts;
    const delta = Math.abs(rowTs - eventTs);
    if (delta <= bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

// Pure event -> row mapper, no DO instance state (the Hype Train level-gate
// lives in ChatHub.handleEventSub, which calls this only for rows that
// should actually render). rewardTitle/userInput are ellipsized here — this
// is the one place viewer-controlled EventSub text is capped before it can
// ever reach pushMessage/the ring. All three sys values below (redeem, hype,
// ad) are silent by design: emitCategory only treats `kind` or sys:'raid' as
// non-silent, so none of these ever buzz or speak.
export function mapEventToRow(subType, event) {
  if (!event || typeof event !== 'object') return null;
  switch (subType) {
    case 'channel.channel_points_custom_reward_redemption.add': {
      const user = typeof event.user_name === 'string' && event.user_name ? event.user_name : 'unknown';
      const rewardTitle = ellipsize(event.reward && event.reward.title, REWARD_TITLE_MAX);
      const userInput = typeof event.user_input === 'string' && event.user_input
        ? ellipsize(event.user_input, USER_INPUT_MAX)
        : '';
      return { user, sys: 'redeem', rewardTitle, ...(userInput ? { userInput } : {}) };
    }
    case 'channel.hype_train.begin':
      return { sys: 'hype', text: `Hype Train started — level ${event.level}` };
    case 'channel.hype_train.progress':
      return { sys: 'hype', text: `Hype Train level ${event.level} — ${event.progress}/${event.goal}` };
    case 'channel.hype_train.end':
      return { sys: 'hype', text: `Hype Train ended — level ${event.level}, total ${event.total}` };
    case 'channel.ad_break.begin': {
      const auto = event.is_automatic === true || event.is_automatic === 'true';
      return { sys: 'ad', text: `Ad break — ${event.duration_seconds}s${auto ? ' (auto)' : ''}` };
    }
    case 'channel.bits.use': {
      if (event.type === 'cheer') return null; // IRC's own bits tag owns cheer rows — no double gold row
      const user = typeof event.user_name === 'string' && event.user_name ? event.user_name : 'unknown';
      const bits = Number.isFinite(event.bits) ? event.bits : 0;
      if (event.type === 'power_up') {
        const powerUpType = event.power_up && event.power_up.type;
        const POWER_UP_LABELS = {
          gigantify_an_emote: 'Gigantify an Emote',
          message_effect: 'Message Effect',
          celebration: 'On-Screen Celebration',
        };
        const powerUpLabel = POWER_UP_LABELS[powerUpType];
        if (!powerUpLabel) {
          console.log(JSON.stringify({ ev: 'bits_use_unmapped', branch: 'power_up', type: event.type, powerUpType }));
          return null; // unknown future power-up type — fail closed, don't guess a label
        }
        let emote;
        if (powerUpType === 'gigantify_an_emote') {
          const rawEmote = event.power_up.emote;
          if (rawEmote && typeof rawEmote.id === 'string' && rawEmote.id) {
            emote = { id: rawEmote.id, name: typeof rawEmote.name === 'string' ? rawEmote.name : '' };
          } else {
            console.log(JSON.stringify({ ev: 'bits_use_gigantify_no_emote', branch: 'power_up', powerUpType }));
          }
        }
        return { user, kind: 'power_up', amount: `${bits} bits`, powerUpType, powerUpLabel, text: powerUpLabel, ...(emote ? { emote } : {}) };
      }
      if (event.type === 'custom_power_up') {
        const rawTitle = event.custom_power_up && event.custom_power_up.title;
        if (typeof rawTitle !== 'string' || !rawTitle) {
          console.log(JSON.stringify({ ev: 'bits_use_unmapped', branch: 'custom_power_up', type: event.type }));
          return null; // fail closed — mirror the power_up branch, don't guess a label
        }
        const powerUpLabel = ellipsize(rawTitle, REWARD_TITLE_MAX);
        return { user, kind: 'power_up', amount: `${bits} bits`, powerUpType: 'custom_power_up', powerUpLabel, text: powerUpLabel };
      }
      console.log(JSON.stringify({ ev: 'bits_use_unmapped', branch: 'unrecognized_type', type: event.type }));
      return null; // unrecognized future `type` value — fail closed
    }
    // Rendered set is 11 of the ~30 possible `action` values: the core 6
    // (timeout/ban/unban/untimeout/delete/warn) plus the 5 shared_chat_*
    // variants — un-deferred because IRC has no shared-chat-aware row to
    // fall back to once applyClearchat/applyClearmsg suppress their own row
    // for an owned action (see those methods). Every other action
    // (emoteonly, mod, vip, raid, add_blocked_term, ...) is frequent/expected
    // and returns null silently — logging each would be noise, not signal.
    // An OWNED action with a missing/malformed sub-object is different: that
    // should never happen per the documented payload shapes, so it logs
    // 'modact_unmapped' before returning null (mirrors bits_use_unmapped).
    case 'channel.moderate': {
      const action = event.action;
      const RENDERED_MODERATE_ACTIONS = new Set([
        'timeout', 'ban', 'unban', 'untimeout', 'delete', 'warn',
        'shared_chat_ban', 'shared_chat_unban', 'shared_chat_timeout', 'shared_chat_untimeout', 'shared_chat_delete',
      ]);
      if (!RENDERED_MODERATE_ACTIONS.has(action)) return null; // unowned action — silent, expected/frequent
      const detail = event[action];
      const userName = detail && typeof detail === 'object' && typeof detail.user_name === 'string' && detail.user_name
        ? detail.user_name
        : null;
      const isTimeout = action === 'timeout' || action === 'shared_chat_timeout';
      const expiresAtMs = isTimeout ? Date.parse((detail && detail.expires_at) || '') : null;
      if (!userName || (isTimeout && !Number.isFinite(expiresAtMs))) {
        console.log(JSON.stringify({ ev: 'modact_unmapped', action, reason: 'missing_fields' }));
        return null;
      }
      const mod = typeof event.moderator_user_name === 'string' && event.moderator_user_name ? event.moderator_user_name : 'a moderator';
      const baseAction = action.startsWith('shared_chat_') ? action.slice('shared_chat_'.length) : action;
      const source = action.startsWith('shared_chat_')
        && typeof event.source_broadcaster_user_name === 'string' && event.source_broadcaster_user_name
        ? event.source_broadcaster_user_name
        : null;
      let text;
      switch (baseAction) {
        case 'timeout':
          text = `${mod} timed out ${userName} (${formatDuration((expiresAtMs - Date.now()) / 1000)})`;
          break;
        case 'ban':
          text = `${mod} banned ${userName}`;
          break;
        case 'unban':
          text = `${mod} unbanned ${userName}`;
          break;
        case 'untimeout':
          text = `${mod} removed timeout on ${userName}`;
          break;
        case 'delete':
          text = `${mod} deleted ${userName}'s message`;
          break;
        case 'warn':
          text = `${mod} warned ${userName}`;
          break;
      }
      if (source) text += ` (shared chat: ${source})`;
      return { sys: 'modact', text };
    }
    default:
      return null;
  }
}

// Output category for a row — the ONE thing that decides what a row produces:
//   financial → buzz + speak,  raid → buzz only,  everything else → silent.
// member_gift_received is excluded from financial so a gift bomb buzzes once,
// not once per redemption row. Raids buzz (a raid scrolling past as gray noise
// is how we missed one on-stream) but are never spoken.
// Username color precedence, shared by both platforms: mod (authority,
// includes broadcaster) > financial event (one-off, salient gold) >
// paid member/sub (baseline status) > default text color. Twitch's
// per-user chosen tags.color is deliberately never consulted here — role
// color only, everyone else renders in the page's default text color.
export function roleClass(msg) {
  if (msg.isMod) return 'mod';
  if (msg.kind) return 'paid';
  if (msg.isMember) return 'member';
  return '';
}

export function emitCategory(msg) {
  if (msg.kind && msg.kind !== 'member_gift_received') return 'financial';
  if (msg.sys === 'raid') return 'raid';
  return 'silent';
}

// The single shared eligibility gate for BOTH the haptic buzz and TTS — a row
// fires at most once per id, live or replayed, guarded three ways: a non-silent
// category, above the persisted high-water floor, not already fired (spokenIds),
// and recent enough (EMIT_TTL_MS) that a stale floor can't replay history.
// Deliberately excludes device/toggle capability (navigator.vibrate,
// speechSynthesis, the on/off toggle) — iOS Safari has no navigator.vibrate at
// all, so bundling capability here would make TTS permanently silent on the
// exact device this feature targets. Each call site layers its own capability
// check on top, so buzz and speak decide from ONE predicate and never diverge.
// Recovered gap rows get fresh monotonic ids (see pushMessage), so `id > floor`
// never wrongly silences a donation that landed during a connection blip.
export function isEmittable(msg, { floor, spokenIds, now }) {
  return emitCategory(msg) !== 'silent'
    && msg.id > floor
    && !spokenIds.has(msg.id)
    && now - msg.ts < EMIT_TTL_MS;
}

// Never reads msg.text — only user/kind/amount/streakMonths/shouldShareStreak
// reach the synthesizer, so raw chat text structurally cannot be spoken. The name is
// run through cleanSpokenName for speech only — msg.user itself is untouched,
// so the on-screen row still shows the raw name; speaks-what-buzzes is
// intentionally relaxed here (see docs/ARCHITECTURE.md).
// streakMonths speaks only at 2+, AND only when shouldShareStreak isn't
// explicitly false — Twitch can still send a nonzero streak-months tag
// even when the user hid their streak (msg-param-should-share-streak=0),
// so streakMonths alone isn't a safe hide signal (see parseShouldShareStreak).
// shouldShareStreak undefined (tag absent, e.g. older/rare clients) defaults
// to shown, same fail-open posture as the rest of this parser. Cumulative
// months is display-only, never spoken. Sub-only: no other kind ever carries
// streakMonths (see parseUsernotice), but the kind check stays explicit
// rather than relying on that invariant silently.
export function formatUtterance(msg) {
  const label = TTS_LABELS[msg.kind] || msg.kind;
  const parts = [cleanSpokenName(msg.user), label];
  if (
    msg.kind === 'sub'
    && typeof msg.streakMonths === 'number'
    && msg.streakMonths >= 2
    && msg.shouldShareStreak !== false
  ) {
    parts.push(`${msg.streakMonths} month streak`);
  }
  if (msg.amount) parts.push(msg.amount);
  return parts.join(', ');
}

// Overlay-only. Unlike formatUtterance above (PWA, frozen — "PWA keeps Web
// Speech, unchanged" — never reads msg.text), this CAN speak a financial
// row's message body, opt-in via the overlay's ttsBody param. Callers must
// only invoke this for financial rows — never chat/raid/sys. base is
// formatUtterance's own output verbatim, so a body that sanitizes down to ''
// (e.g. a message that was only a URL) degrades exactly to today's PWA
// summary line, never to a broken or silent utterance.
export function formatOverlayUtterance(msg, { speakBody }) {
  const base = formatUtterance(msg);
  if (!speakBody || !msg.text) return base;
  const body = sanitizeSpokenBody(msg.text);
  return body ? `${base}, ${body}` : base;
}

// Pending-utterance queue cap: drop oldest beyond `cap`, keep the rest in
// arrival order. `cap` counts pending items only — not the one mid-speech.
export function enqueueCapped(queue, item, cap) {
  const next = [...queue, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// Compact k/M count formatting for the top-bar chips — <1000 as-is, one
// decimal above that with a trailing ".0" trimmed (1200 -> "1.2k", 3000000 ->
// "3M"). null/undefined/non-finite -> '' so the client can hide the count
// span entirely rather than render something misleading.
export function formatCount(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1000) return String(n);
  const scaled = n >= 1_000_000 ? [n / 1_000_000, 'M'] : [n / 1000, 'k'];
  let out = scaled[0].toFixed(1);
  if (out.endsWith('.0')) out = out.slice(0, -2);
  return out + scaled[1];
}

// Fragment always wins over stale storage (a fresh install link with a
// rotated secret must not be shadowed by an old localStorage token).
export function resolveToken({ fragmentToken, storedToken }) {
  if (fragmentToken) return { token: fragmentToken, action: 'persist' };
  if (storedToken) return { token: storedToken, action: 'none' };
  return { token: null, action: 'prompt' };
}

// Pull-to-refresh gesture phase — stateless function of the current vertical
// drag distance, so the touchmove handler stays a thin DOM binding. deltaY<=0
// always reads 'idle': that's normal downward-scroll intent (finger moving up,
// content scrolling down), never a pull, and must cancel cleanly regardless of
// how far the gesture had progressed a moment earlier.
export function pullPhase(deltaY, thresholdPx) {
  if (deltaY <= 0) return 'idle';
  return deltaY >= thresholdPx ? 'ready' : 'pulling';
}

// Pull-to-refresh settle-listener race guard. triggerPullRefresh's
// onConnected callback fires asynchronously, after a network round trip —
// if this pull's own timeout settles it first (network slower than 3s), or
// a newer pull has since started, the late callback must not attach a
// {once:true} message/status listener: it could fire on a different pull's
// socket and hide that pull's indicator before its own refresh completes.
// start() is called once per pull gesture; isCurrent(token) is checked
// right before attaching the listener.
export function createPullGate() {
  let token = 0;
  return {
    start() { return ++token; },
    isCurrent(myToken) { return myToken === token; },
  };
}

// Pull-to-refresh version gate. A missing version on either side (fetch
// failed, or the client's own build const didn't interpolate) must never
// force a reload loop — only an unambiguous, confirmed mismatch does.
// Explicit undefined/null/'' checks, not Boolean() coercion — a legit
// version value of 0 is falsy but must still count as present.
export function versionMismatch(clientVersion, serverVersion) {
  const hasClient = clientVersion !== undefined && clientVersion !== null && clientVersion !== '';
  const hasServer = serverVersion !== undefined && serverVersion !== null && serverVersion !== '';
  return hasClient && hasServer && clientVersion !== serverVersion;
}

// forensics rec 1: the only staleness predicate — shared by the
// visibilitychange check and the periodic watchdog interval below, so
// "nothing (not even a ping) heard in a while" means the exact same thing
// whichever trigger noticed it. lastActivityTs is bumped by every SSE
// signal (open/message/ping/status/mark), not just chat messages, so a
// quiet-but-live YT feed riding on Twitch/heartbeat traffic never trips
// this on its own — see internal forensics doc (2026-08-05), rec 1.
export function isClientStale(lastActivityTs, now, staleAfterMs) {
  return now - lastActivityTs > staleAfterMs;
}

// forensics rec 1: connect() already called this inline before this
// extraction — pulled out as its own predicate so the "a fresh connect()
// always supersedes any prior EventSource first" guarantee has a direct
// regression test, independent of DOM/EventSource plumbing this repo has no
// harness for. This is what keeps a periodic watchdog-triggered connect()
// from ever creating a same-page concurrent connection (the forensics doc's
// one unconfirmed loss-mechanism lead, §5).
export function supersedeSocket(prevSocket) {
  if (prevSocket) {
    try { prevSocket.close(); } catch {}
  }
}

// forensics rec 5: session-scoped send cap for the client error beacon — a
// looping error must never spam the endpoint or the log.
export function shouldSendClientError(countSoFar, max) {
  return countSoFar < max;
}

// ── Static page ──────────────────────────────────────────────────────────

// JSON-into-<script> interpolation must escape `<` — otherwise a value
// containing "</script>" (or "<!--") breaks out of the inline script block.
// Values here are operator/deploy-controlled, not attacker data, so this is
// conformance rather than a live vuln — but a pathological
// MULTICHAT_MY_NAME shouldn't be able to break/attack its own page.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function pageHtml(myName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="multichat">
<meta name="theme-color" content="#0b0b0f">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/favicon.ico">
<title>multichat</title>
<style>
  :root { color-scheme: dark; --role-mod: #5096ff; --role-member: #2ecc71; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0b0f; color: #e8e8ea; font: 15px/1.4 -apple-system, system-ui, sans-serif; }
  #feed { height: 100%; overflow-y: auto; overscroll-behavior: contain; padding: calc(30px + env(safe-area-inset-top, 0px)) 10px 24px; -webkit-overflow-scrolling: touch; overflow-anchor: none; }
  .msg { padding: 3px 0; word-break: break-word; }
  .msg.paid { background: rgba(255, 200, 0, 0.1); border-left: 3px solid #ffc700; padding-left: 6px; margin-left: -9px; }
  .msg.recovered { opacity: .55; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; margin-right: 5px; }
  .badge.tw { background: #9146FF; color: #fff; }
  .badge.yt { background: #FF0000; color: #fff; }
  .amount { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: #ffc700; color: #1a1400; margin-right: 5px; }
  .user { font-weight: 600; }
  .user.mod { color: var(--role-mod); }
  .user.paid { color: #ffc700; }
  .user.member { color: var(--role-member); }
  .mention { background: #e63946; color: #fff; border-radius: 3px; padding: 0 2px; }
  .msg.info { color: #8a8a90; }
  .msg.raid { border: 2px solid #9147ff; border-radius: 6px; background: rgba(145, 71, 255, 0.12); padding: 6px 8px; margin: 4px 0; font-weight: 700; font-size: 1.1em; }
  .msg.redeem { border-left: 3px solid #1fd1b5; background: rgba(31, 209, 181, 0.10); padding-left: 6px; margin-left: -9px; }
  .msg.deleted > span:last-of-type { text-decoration: line-through; opacity: .6; }
  .emote { height: 1.4em; width: auto; vertical-align: middle; }
  .emote.gigantify { display: block; height: 4em; margin-top: 4px; }
  .gif { display: block; max-height: 96px; max-width: 100%; width: auto; height: auto; border-radius: 6px; margin-top: 4px; }
  .gif-chip { display: inline-block; background: #2a2a32; color: #9a9aa2; border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; margin-top: 2px; }
  .gif-alt { color: #8a8a90; }
  .firstmsg { margin-right: 4px; }
  #resume { position: fixed; top: calc(34px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); background: #1f1f26; color: #e8e8ea; border: 1px solid #333; border-radius: 999px; padding: 6px 14px; font-size: 13px; display: none; z-index: 15; }
  #resume.show { display: block; }
  #pullIndicator { position: fixed; top: calc(6px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); background: #1f1f26; color: #e8e8ea; border: 1px solid #333; border-radius: 999px; padding: 4px 12px; font-size: 11px; display: none; z-index: 16; pointer-events: none; }
  #pullIndicator.show { display: block; }
  #banner { position: fixed; top: 0; left: 0; right: 0; background: #5a1a1a; color: #fff; text-align: center; font-size: 13px; padding: calc(6px + env(safe-area-inset-top, 0px)) 6px 6px; display: none; z-index: 20; }
  #banner.show { display: block; }
  #staleIndicator { position: fixed; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); left: 50%; transform: translateX(-50%); background: #4a3a12; color: #e8c46a; border: 1px solid #6b5320; border-radius: 999px; padding: 4px 12px; font-size: 11px; display: none; z-index: 18; pointer-events: none; }
  #staleIndicator.show { display: block; }
  #topbar { position: fixed; top: calc(6px + env(safe-area-inset-top, 0px)); left: 8px; right: 8px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; font-size: 10px; color: #666; z-index: 10; pointer-events: none; }
  #chips { display: flex; gap: 8px; justify-self: center; }
  .chip { display: flex; align-items: center; gap: 3px; transition: color .6s; }
  .chip::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #555; display: inline-block; transition: background-color .6s; }
  .chip.live::before { background: #2ecc71; }
  .chip.warn::before { background: #e2b93b; }
  .chip.stale::before { background: #c0392b; }
  .chip.flash-gold { color: #ffc700; }
  .chip.flash-gold::before { background: #ffc700; }
  .count { margin-left: 3px; }
  .count:empty { display: none; }
  .count.stale { opacity: .45; }
  #controls { display: flex; gap: 4px; pointer-events: none; justify-self: end; }
  #fontToggle, #speakToggle, #gifsToggle, #tokenToggle, #refreshBtn { pointer-events: auto; background: #1f1f26; color: #e8e8ea; border: 1px solid #333; border-radius: 4px; font-size: 10px; padding: 2px 6px; }
  #tokenPrompt { position: fixed; top: 40%; left: 50%; transform: translateX(-50%); background: #1f1f26; border: 1px solid #333; border-radius: 8px; padding: 12px; display: none; z-index: 25; gap: 6px; }
  #tokenPrompt.show { display: flex; }
  #tokenPrompt input { background: #0b0b0f; color: #e8e8ea; border: 1px solid #333; border-radius: 4px; padding: 6px; font-size: 13px; }
  #tokenPrompt button { background: #5096ff; color: #0b0b0f; border: none; border-radius: 4px; padding: 6px 10px; font-weight: 700; }
</style>
</head>
<body>
<div id="banner">disconnected — reconnecting…</div>
<div id="staleIndicator">connection lagging…</div>
<div id="topbar">
  <button id="tokenToggle">⚿</button>
  <div id="chips"><span class="chip" id="chip-tw">TW<span class="count" id="count-tw"></span></span><span class="chip" id="chip-yt">YT<span class="count" id="count-yt"></span></span></div>
  <div id="controls">
    <button id="speakToggle">🔇</button>
    <button id="gifsToggle">🎞️</button>
    <button id="fontToggle">A</button>
    <button id="refreshBtn">↻</button>
  </div>
</div>
<div id="feed"></div>
<div id="pullIndicator"></div>
<button id="resume"></button>
<div id="tokenPrompt">
  <input id="tokenInput" type="text" placeholder="paste token" autocomplete="off">
  <button id="tokenSubmit">Connect</button>
</div>
<script>
(function () {
  const params = new URLSearchParams(location.hash.slice(1));
  const tokenPromptEl = document.getElementById('tokenPrompt');
  const tokenInput = document.getElementById('tokenInput');
  const tokenSubmit = document.getElementById('tokenSubmit');
  const tokenToggle = document.getElementById('tokenToggle');
  let token = null;
  const feed = document.getElementById('feed');
  const resumeBtn = document.getElementById('resume');
  const bannerEl = document.getElementById('banner');
  const staleIndicatorEl = document.getElementById('staleIndicator');
  const refreshBtn = document.getElementById('refreshBtn');
  const chipTw = document.getElementById('chip-tw');
  const chipYt = document.getElementById('chip-yt');
  const countTw = document.getElementById('count-tw');
  const countYt = document.getElementById('count-yt');
  const fontToggle = document.getElementById('fontToggle');
  const MY_NAME = ${jsonForScript(myName)}; // empty disables self-mention highlighting
  const MAX_ROWS = 300;
  const STALE_AFTER_MS = 60_000; // reconnect if nothing (not even a ping) heard in this long while backgrounded
  const WATCHDOG_POLL_MS = 15_000; // forensics rec 1: catches a foregrounded-but-lagging tab without waiting on visibilitychange
  // forensics rec 2: derived from the server's own ping cadence (never a second
  // hardcoded literal that could drift from it) — must clear it with real
  // margin or the indicator flickers on every healthy connection whenever a
  // ping lands a bit late.
  const PING_INTERVAL_MS = ${HEARTBEAT_MS};
  const SOFT_STALE_MS = PING_INTERVAL_MS + 15_000;
  const CHIP_WARN_MS = 60_000;
  const CHIP_STALE_MS = 90_000;
  const CLIENT_ERROR_SEND_MAX = 5; // forensics rec 5: session-scoped cap — a looping error must never spam the endpoint/log

  let paused = false; // true once the viewer has scrolled down into history
  let unseenCount = 0;
  let lastMsgId = 0;
  let lastActivityTs = Date.now();
  let es = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let clientErrorSentCount = 0;

  // forensics rec 5: minimal error beacon — this investigation hit a hard
  // wall trying to explain a reported red YT chip with no way to see what
  // the client actually did. Gated on the same view token /events already
  // uses (handleClientError, worker.js), rate-capped client-side, fire-and-
  // forget so a reporting failure can never itself break anything.
  function reportClientError(info) {
    if (!token || !shouldSendClientError(clientErrorSentCount, CLIENT_ERROR_SEND_MAX)) return;
    clientErrorSentCount++;
    let payload;
    try {
      payload = JSON.stringify({
        message: String((info && info.message) || 'unknown error').slice(0, 500),
        source: info && info.source ? String(info.source).slice(0, 500) : undefined,
        line: info && Number.isFinite(info.line) ? info.line : undefined,
        col: info && Number.isFinite(info.col) ? info.col : undefined,
        stack: info && info.stack ? String(info.stack).slice(0, 500) : undefined,
        ts: Date.now(),
      });
    } catch { return; }
    const url = '/client-error?t=' + encodeURIComponent(token);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
      }
    } catch {}
  }
  window.addEventListener('error', (e) => {
    reportClientError({ message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    reportClientError({
      message: 'unhandledrejection: ' + (reason && reason.message ? reason.message : String(reason)),
      stack: reason && reason.stack,
    });
  });

  // Font-size cycle: 4 fixed sizes, button label stays static ("A") — no per-size text.
  // Namespaced key (distinct from the old binary 'multichat-fontsize') —
  // an old 'large'/'normal' value simply misses FONT_SIZES.indexOf and
  // falls back to the default, no migration needed.
  const FONT_SIZES = [13, 15, 17, 20];
  const FONT_SIZE_KEY = 'multichat-fontsize-px';
  let fontSizeIdx = FONT_SIZES.indexOf(Number(localStorage.getItem(FONT_SIZE_KEY)));
  if (fontSizeIdx === -1) fontSizeIdx = FONT_SIZES.indexOf(15);
  function applyFontSize(px) {
    document.body.style.fontSize = px + 'px';
  }
  applyFontSize(FONT_SIZES[fontSizeIdx]);
  fontToggle.addEventListener('click', () => {
    fontSizeIdx = (fontSizeIdx + 1) % FONT_SIZES.length;
    const px = FONT_SIZES[fontSizeIdx];
    localStorage.setItem(FONT_SIZE_KEY, String(px));
    applyFontSize(px);
  });

  // ── GIF render toggle ────────────────────────────────────────────────
  // Default ON. Off = tappable [GIF] chip (renderGifToken in lib.js) instead
  // of an eager <img> — IRL cellular bandwidth, GIFs are multi-MB and Twitch
  // forbids picking a smaller rendition. Same localStorage on/off pattern as
  // multichat-speak below, but polarity flipped (absence = on, not off).
  const gifsToggle = document.getElementById('gifsToggle');
  let gifsEnabled = localStorage.getItem('multichat-gifs') !== 'off';
  function updateGifsToggleLabel() {
    gifsToggle.textContent = gifsEnabled ? '🎞️' : '🎞️🚫';
  }
  updateGifsToggleLabel();
  gifsToggle.addEventListener('click', () => {
    gifsEnabled = !gifsEnabled;
    localStorage.setItem('multichat-gifs', gifsEnabled ? 'on' : 'off');
    updateGifsToggleLabel();
  });

  // ── TTS read-aloud ───────────────────────────────────────────────────
  const speakToggle = document.getElementById('speakToggle');
  const TTS_LABELS = ${jsonForScript(TTS_LABELS)};
  const EMIT_TTL_MS = ${EMIT_TTL_MS};
  const BUILD_VERSION = ${jsonForScript(RELEASE_VERSION)};
  // NOTE: these interpolate the literal function source via Function.prototype.toString().
  // CONFIRMED LIVE, not inert (2026-09-03 incident): wrangler deploy minifies
  // via esbuild by default even with no explicit "minify" key in
  // wrangler.jsonc -- wrangler dev and plain vitest imports do NOT, so this
  // class of bug is invisible to npm test and to local dev, only to the
  // real deployed bundle. Confirmed failure mode wasn't a renamed identifier
  // but esbuild wrapping a locally-scoped named closure (e.g. a const-bound
  // arrow, or a nested function declaration, inside an interpolated
  // function) in its own __name() runtime helper -- defined only in the
  // SERVER's bundle, absent client-side -- baked into that closure's own
  // toString() text. ReferenceError, silently swallowed by
  // socket.onmessage's empty catch block, no console error. Root-caused via
  // wrangler deploy --dry-run --outdir (no real deploy needed to
  // reproduce/verify) in test/bundle-gif-render.test.js, which is the only
  // test in this repo that drives the real bundled/minified output rather
  // than plain source -- extend that guard, don't bypass it, for any future
  // interpolated function that defines its own local closure.
  // IMPORTANT: this comment block itself sits inside pageHtml's own
  // template-literal return value -- never write a backtick character
  // anywhere in this block, it would terminate that outer string early.
  ${roleClass}
  ${emitCategory}
  ${isEmittable}
  ${resolveToken}
  ${cleanSpokenName}
  ${formatUtterance}
  ${enqueueCapped}
  ${formatCount}
  ${pullPhase}
  ${versionMismatch}
  ${createPullGate}
  ${isClientStale}
  ${supersedeSocket}
  ${shouldSendClientError}

  // Speak/buzz-once-per-id state. floor = high-water mark of fired ids; spokenIds
  // = recently-fired ids (TTL-pruned). Both persist so a page reload / iOS
  // background revival behaves like a reconnect: donations that arrived while the
  // page was away fire once (via the replay the restored lastMsgId requests)
  // instead of being re-floored into silence, while a stale floor can't flood
  // (the EMIT_TTL_MS age term in isEmittable gates old rows). Fresh device /
  // cleared storage degrades to floor 0 (plain live behavior).
  let emitFloor = 0;
  let spokenIds = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem('multichat-spoken') || '{}');
    const now = Date.now();
    if (typeof saved.floor === 'number' && saved.floor > 0) emitFloor = saved.floor;
    if (typeof saved.lastMsgId === 'number' && saved.lastMsgId > 0) lastMsgId = saved.lastMsgId;
    if (Array.isArray(saved.ids)) {
      for (const pair of saved.ids) {
        if (Array.isArray(pair) && typeof pair[0] === 'number' && now - pair[1] < EMIT_TTL_MS) spokenIds.set(pair[0], pair[1]);
      }
    }
  } catch {}
  function pruneSpoken(now) {
    for (const [id, ts] of spokenIds) if (now - ts >= EMIT_TTL_MS) spokenIds.delete(id);
  }
  function persistEmitState() {
    try {
      localStorage.setItem('multichat-spoken', JSON.stringify({ floor: emitFloor, lastMsgId, ids: [...spokenIds] }));
    } catch {}
  }
  // The one place buzz/speak fire — both gate on the SAME isEmittable predicate
  // so they never diverge, then layer their own capability check. category
  // decides the outputs (financial = buzz + speak, raid = buzz only).
  function fireEmission(msg, buzzPattern) {
    const now = Date.now();
    if (!isEmittable(msg, { floor: emitFloor, spokenIds, now })) return;
    spokenIds.set(msg.id, now);
    pruneSpoken(now);
    emitFloor = msg.id; // isEmittable guaranteed msg.id > emitFloor
    persistEmitState();
    if (navigator.vibrate) navigator.vibrate(buzzPattern);
    if (emitCategory(msg) === 'financial' && window.speechSynthesis && speakEnabled) maybeSpeak(msg);
  }

  let speakEnabled = localStorage.getItem('multichat-speak') === 'on';
  let speechQueue = [];
  let speaking = false;
  let keepaliveTimer = null;
  let speechGeneration = 0;

  function updateSpeakToggleLabel() {
    speakToggle.textContent = speakEnabled ? '🔊' : '🔇';
  }

  function startKeepalive() {
    if (keepaliveTimer) return;
    keepaliveTimer = setInterval(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 10_000);
  }

  function stopSpeaking() {
    speechGeneration++;
    speechQueue = [];
    speaking = false;
    window.speechSynthesis.cancel();
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function speakNext() {
    if (!speechQueue.length) {
      speaking = false;
      return;
    }
    speaking = true;
    const gen = speechGeneration;
    const utter = new SpeechSynthesisUtterance(speechQueue.shift());
    utter.onend = () => { if (gen === speechGeneration) speakNext(); };
    utter.onerror = () => { if (gen === speechGeneration) speakNext(); };
    window.speechSynthesis.speak(utter);
  }

  function maybeSpeak(msg) {
    speechQueue = enqueueCapped(speechQueue, formatUtterance(msg), 3);
    if (!speaking) speakNext();
  }

  if (window.speechSynthesis) {
    updateSpeakToggleLabel();
    if (speakEnabled) startKeepalive();
    speakToggle.addEventListener('click', () => {
      speakEnabled = !speakEnabled;
      localStorage.setItem('multichat-speak', speakEnabled ? 'on' : 'off');
      updateSpeakToggleLabel();
      if (speakEnabled) {
        speechQueue = enqueueCapped(speechQueue, 'read alerts on', 3);
        if (!speaking) speakNext();
        startKeepalive();
      } else {
        stopSpeaking();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && speakEnabled) window.speechSynthesis.resume();
    });
  } else {
    speakToggle.style.display = 'none';
  }

  function isNearTop() {
    return feed.scrollTop < 40;
  }

  function updatePill() {
    if (paused && unseenCount > 0) {
      resumeBtn.textContent = unseenCount + ' new ↑';
      resumeBtn.classList.add('show');
    } else {
      resumeBtn.classList.remove('show');
    }
  }

  feed.addEventListener('scroll', () => {
    paused = !isNearTop();
    if (!paused) {
      unseenCount = 0;
      updatePill();
    }
  });

  resumeBtn.addEventListener('click', () => {
    paused = false;
    unseenCount = 0;
    feed.scrollTop = 0;
    updatePill();
  });

  // isAllowedEmojiUrl/appendWithMention/renderText/buildRow now live in
  // src/lib.js -- one renderer shared with /overlay, not two. Interpolated via
  // Function.prototype.toString() like roleClass/emitCategory/etc. above; the
  // same minify caveat noted there now covers row rendering too. EMOTE_ID_RE
  // and ALLOWED_EMOJI_HOST_RE are RegExp values, not functions -- RegExp's own
  // toString() still gives valid regex-literal source, so declaring a const
  // from the interpolated value works the same way it does for plain values
  // (TTS_LABELS, RELEASE_VERSION) elsewhere in this block.
  const EMOTE_ID_RE = ${EMOTE_ID_RE};
  const ALLOWED_EMOJI_HOST_RE = ${ALLOWED_EMOJI_HOST_RE};
  const ALLOWED_GIF_HOST_RE = ${ALLOWED_GIF_HOST_RE};
  ${isAllowedEmojiUrl}
  ${isAllowedGifUrl}
  ${renderGifToken}
  ${mergeAnnotations}
  ${appendWithMention}
  ${renderText}
  ${buildRow}

  function addRow(msg) {
    const row = buildRow(msg, { myName: MY_NAME, roleClass, doc: document, mention: true, gifsEnabled });
    if (!row) return; // superseded gigantify candidate — never inserted, see buildRow
    // Raids buzz (double pattern) same as before insertion — fireEmission
    // never reads the DOM, so this ordering relative to insertBefore below
    // is equivalent to the pre-extraction code, just no longer duplicated
    // between the sys and non-sys branches (the insert/scroll/pill block was
    // byte-for-byte identical in both).
    if (msg.sys === 'raid') fireEmission(msg, [80, 40, 80]);
    feed.insertBefore(row, feed.firstChild);
    while (feed.childElementCount > MAX_ROWS) feed.removeChild(feed.lastChild);
    if (!paused) {
      feed.scrollTop = 0;
    } else {
      feed.scrollTop += row.offsetHeight; // keep the content the viewer is reading from jumping
      unseenCount++;
      updatePill();
    }
    // member_gift_received excluded from 'financial' by emitCategory: a 20-gift
    // bomb arrives as one member_gift (buzzes+speaks) plus up to 20 redemption
    // rows — one buzz per bomb, not 21. fireEmission is the single shared gate;
    // vibrate/speak each still check their own device capability on top of it.
    if (!msg.sys) fireEmission(msg, 80);
  }

  // classList-based (not a wholesale className reassignment) so it never
  // clobbers a 'flash-gold' class added independently by maybeFlashGold —
  // the two live on the same element but are driven by unrelated state
  // (chat liveness vs. a count going up) and must not fight each other.
  function setChipLiveness(el, ageMs) {
    el.classList.remove('live', 'warn', 'stale');
    if (ageMs == null) return;
    if (ageMs < CHIP_WARN_MS) el.classList.add('live');
    else if (ageMs < CHIP_STALE_MS) el.classList.add('warn');
    else el.classList.add('stale');
  }

  // Dot state (chipClass) reflects platform chat liveness (lastSeen), fully
  // independent of count staleness below — a stale viewer count dims its own
  // text without touching the dot, and vice versa.
  function renderCount(el, primary, secondary, secondaryGlyph) {
    const parts = [];
    if (primary && primary.v != null) parts.push(formatCount(primary.v));
    if (secondary && secondary.v != null) parts.push((secondaryGlyph || '♥') + formatCount(secondary.v));
    el.textContent = parts.join(' ');
    el.classList.toggle('stale', Boolean((primary && primary.stale) || (secondary && secondary.stale)));
  }

  // Gold flash on a chip whose watched value increased — generic so a
  // viewer-count chip could opt in later by just calling maybeFlashGold
  // with a different key/element/value. baseline===null means "no
  // comparison point yet" (fresh connect, see resetFlashBaselines): the
  // first value received after a reset only establishes the baseline, it
  // never flashes. Only an increase flashes; a decrease just updates the
  // baseline silently. The timer resets (not stacks) on a further increase
  // within the flash window.
  const FLASH_GOLD_MS = 30_000;
  const flashBaseline = { tw: null, yt: null };
  const flashTimer = { tw: null, yt: null };

  function resetFlashBaselines() {
    for (const key of Object.keys(flashBaseline)) {
      flashBaseline[key] = null;
      clearTimeout(flashTimer[key]);
      flashTimer[key] = null;
    }
    chipTw.classList.remove('flash-gold');
    chipYt.classList.remove('flash-gold');
  }

  function maybeFlashGold(key, el, value) {
    if (value == null) return;
    const prev = flashBaseline[key];
    if (prev != null && value > prev) {
      el.classList.add('flash-gold');
      clearTimeout(flashTimer[key]);
      flashTimer[key] = setTimeout(() => el.classList.remove('flash-gold'), FLASH_GOLD_MS);
    }
    flashBaseline[key] = value;
  }

  function renderStatus(status) {
    setChipLiveness(chipTw, status.tw);
    setChipLiveness(chipYt, status.yt);
    const counts = status.counts || {};
    maybeFlashGold('tw', chipTw, counts.twFollowers && counts.twFollowers.v);
    maybeFlashGold('yt', chipYt, counts.ytLikes && counts.ytLikes.v);
    renderCount(countTw, counts.twViewers, counts.twFollowers, '☆');
    renderCount(countYt, counts.ytViewers, counts.ytLikes);
  }

  function showBanner() {
    bannerEl.classList.add('show');
    if (window.speechSynthesis) stopSpeaking();
  }
  function hideBanner() {
    bannerEl.classList.remove('show');
    if (window.speechSynthesis && speakEnabled) startKeepalive();
  }

  // forensics rec 2: decoupled from the platform chips (server-driven,
  // buildStatusPayload's lastSeen) and from #banner (hard disconnect only,
  // fires on EventSource.CLOSED). This reflects the *local* link's own
  // reckoning — "my connection is lagging" — visibly distinct from "YT chat
  // is just quiet" (chips stay green/live either way) and from "fully
  // disconnected, reconnecting" (banner already owns that state, so this
  // never shows on top of it).
  function updateStaleIndicator() {
    if (bannerEl.classList.contains('show')) {
      staleIndicatorEl.classList.remove('show');
      return;
    }
    staleIndicatorEl.classList.toggle('show', isClientStale(lastActivityTs, Date.now(), SOFT_STALE_MS));
  }

  // Shared reconnect core for the refresh button + pull-to-refresh. refreshBusy
  // is a global in-flight guard (separate from pull's own pullBusy, which only
  // gates the pull gesture's indicator) so a double-tap on the button or a
  // pull-during-button-refresh no-ops instead of racing two connect() calls.
  // pendingRefreshConfirm/refreshConfirmTimer clear refreshBusy once the
  // refresh actually resolves: consumed by the next onmessage within ~5s, or
  // cleared by the timeout / a version-mismatch reload (reload navigates away
  // — refreshBusy simply never matters again, and that's fine).
  // onGaveUp fires whenever this call will NOT wait for a live confirmation
  // (no token, or the version fetch itself failed) — pull-to-refresh uses it
  // to hide its indicator immediately instead of riding the 3s fallback, per
  // the documented "same as toggling airplane mode briefly" behavior (5a).
  let refreshBusy = false;
  let pendingRefreshConfirm = false;
  let refreshConfirmTimer = null;

  function clearRefreshPending() {
    pendingRefreshConfirm = false;
    refreshBusy = false;
    clearTimeout(refreshConfirmTimer);
  }

  // pendingRefreshConfirm is deliberately NOT set before the await fetch —
  // it's set only right before each connect() call below, in the same
  // synchronous tick that reassigns es to the new socket. Setting it earlier
  // left a window where a message on the still-open OLD socket would pass
  // its socket-not-equal-es guard (es not reassigned yet), find
  // pendingRefreshConfirm already true, and consume the one-shot confirm
  // before the refresh actually happened.
  function refreshReconnect(onConnected, onGaveUp) {
    if (refreshBusy) return;
    refreshBusy = true;
    fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()).then((data) => {
      if (versionMismatch(BUILD_VERSION, data.releaseVersion)) {
        location.reload();
        return;
      }
      if (!token) {
        clearRefreshPending();
        if (onGaveUp) onGaveUp();
        return;
      }
      pendingRefreshConfirm = true;
      refreshConfirmTimer = setTimeout(clearRefreshPending, 5000);
      connect();
      if (onConnected) onConnected(es);
    }).catch(() => {
      if (token) {
        pendingRefreshConfirm = true;
        refreshConfirmTimer = setTimeout(clearRefreshPending, 5000);
        connect();
        if (onConnected) onConnected(es);
      } else {
        clearRefreshPending();
      }
      if (onGaveUp) onGaveUp();
    });
  }

  refreshBtn.addEventListener('click', () => {
    refreshReconnect();
  });

  function scheduleReconnect() {
    showBanner();
    clearTimeout(reconnectTimer);
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    supersedeSocket(es);
    // Every (re)connect — first load, watchdog reconnect, refresh button,
    // PTR — gets a fresh gold-flash baseline. Without this, the first
    // status payload after any reconnect would flash on values that never
    // actually changed, just re-observed after a gap.
    resetFlashBaselines();
    const url = '/events?t=' + encodeURIComponent(token) + (lastMsgId ? '&lastEventId=' + lastMsgId : '');
    const socket = new EventSource(url);
    es = socket;
    // Handlers close over socket, not the mutable es binding — a handler
    // firing late on a superseded connection must not act on the new one.
    socket.onopen = () => {
      if (socket !== es) return;
      reconnectAttempt = 0;
      lastActivityTs = Date.now();
      // No burst-window gate here anymore — isEmittable's floor+spokenIds+TTL
      // predicate (2.3) is what suppresses replay bursts on every (re)connect,
      // live and first-load alike, without a fixed post-open time window.
      hideBanner();
      staleIndicatorEl.classList.remove('show');
    };
    socket.onmessage = (e) => {
      if (socket !== es) return;
      lastActivityTs = Date.now();
      try {
        const msg = JSON.parse(e.data);
        lastMsgId = msg.id;
        if (pendingRefreshConfirm) clearRefreshPending();
        addRow(msg);
      } catch (err) {
        // Was a bare empty catch — exactly what let the 2026-09-03 esbuild
        // __name incident (see renderGifToken in lib.js) render invisible in
        // production. Report error name + message only, never e.data/msg
        // (chat-derived frame contents) — reportClientError already caps
        // length and rate-limits itself. Deliberately no rethrow/return-out:
        // one bad frame must never stop the next one from rendering.
        reportClientError({ message: (err && err.name ? err.name + ': ' : '') + (err && err.message || 'unknown error'), source: 'sse-onmessage' });
      }
    };
    socket.addEventListener('ping', () => { if (socket === es) lastActivityTs = Date.now(); });
    socket.addEventListener('status', (e) => {
      if (socket !== es) return;
      lastActivityTs = Date.now();
      try { renderStatus(JSON.parse(e.data)); } catch (err) {
        reportClientError({ message: 'status render failed: ' + (err && err.message), stack: err && err.stack });
      }
    });
    // Transient live-only mark (delete/timeout/ban) — see markDeleted in worker.js.
    // Not replayed: rows already carrying msg.deleted arrive pre-marked instead.
    // No-op if the target row scrolled out of the ring / off MAX_ROWS.
    socket.addEventListener('mark', (e) => {
      if (socket !== es) return;
      lastActivityTs = Date.now();
      try {
        const m = JSON.parse(e.data);
        let sel = null;
        if (m.action === 'delete') {
          sel = m.platform === 'yt'
            ? (m.targetId ? '[data-ytid="' + CSS.escape(m.targetId) + '"]' : null)
            : (m.targetId ? '[data-twid="' + CSS.escape(m.targetId) + '"]' : null);
        } else if (m.action === 'author_delete') {
          sel = m.authorId ? '[data-ytauthor="' + CSS.escape(m.authorId) + '"]' : null;
        } else if (m.action === 'supersede') {
          // Gigantify double-display suppression (live, already-rendered
          // row) — fully removed, not struck-through: see markSuperseded.
          sel = m.targetId ? '[data-twid="' + CSS.escape(m.targetId) + '"]' : null;
        } else {
          sel = m.login ? '[data-login="' + CSS.escape(m.login) + '"]' : null;
        }
        if (sel) {
          feed.querySelectorAll(sel).forEach((r) => {
            if (m.action === 'supersede') r.remove(); else r.classList.add('deleted');
          });
        }
      } catch {}
    });
    socket.onerror = () => {
      if (socket !== es) return;
      if (socket.readyState === EventSource.CLOSED) scheduleReconnect();
    };
  }

  // forensics rec 1: shared by the visibilitychange check below and a new
  // periodic watchdog timer — previously this only re-ran on visibilitychange,
  // so a foregrounded-but-lagging tab (no backgrounding event to trigger the
  // check) had to wait on the ~75s backpressure reaper before recovering.
  // connect() always supersedes any prior socket first (supersedeSocket
  // above), so calling it here on a timer can never create a same-page
  // concurrent connection.
  function checkStaleAndReconnect() {
    if (token && isClientStale(lastActivityTs, Date.now(), STALE_AFTER_MS)) {
      connect();
    }
  }
  setInterval(() => {
    checkStaleAndReconnect();
    updateStaleIndicator();
  }, WATCHDOG_POLL_MS);

  function showTokenPrompt() {
    tokenInput.value = '';
    tokenPromptEl.classList.add('show');
    tokenInput.focus();
  }
  function hideTokenPrompt() {
    tokenPromptEl.classList.remove('show');
  }
  function applyToken(value) {
    token = value;
    localStorage.setItem('multichat-token', token);
    hideTokenPrompt();
    connect();
  }
  tokenSubmit.addEventListener('click', () => {
    const v = tokenInput.value.trim();
    if (v) applyToken(v);
  });
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tokenSubmit.click();
  });
  tokenToggle.addEventListener('click', showTokenPrompt);

  const fragmentToken = params.get('t');
  const storedToken = localStorage.getItem('multichat-token');
  const resolved = resolveToken({ fragmentToken, storedToken });
  if (resolved.action === 'prompt') {
    showTokenPrompt();
  } else {
    token = resolved.token;
    if (resolved.action === 'persist') {
      localStorage.setItem('multichat-token', token);
      history.replaceState(null, '', location.pathname + location.search);
    }
    connect();
  }

  let wakeLock = null;
  async function requestWakeLock() {
    if (wakeLock) return;
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (err) {
      console.error('wake lock request failed:', err.message);
    }
  }
  requestWakeLock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      // iOS can suspend the tab's network entirely in the background; if
      // nothing (not even a ping) came through recently, the EventSource is
      // likely dead without ever firing onerror — force a fresh connection.
      checkStaleAndReconnect();
    }
  });
  // Some WebKit/iOS versions silently reject a wake-lock request that isn't
  // tied to a user gesture — re-acquire on the first tap as a fallback.
  document.addEventListener('click', requestWakeLock);
  document.addEventListener('touchstart', requestWakeLock, { passive: true });

  // ── Pull-to-refresh (installed PWA only) ────────────────────────────────
  // display-mode:standalone gates this: an installed PWA has no browser
  // chrome to supply native pull-to-refresh, so this is the only refresh
  // affordance on that surface. Browser-tab Safari keeps its native pull —
  // no competing gesture is added there. feed's touchstart still bubbles to
  // the document-level unlockTts/requestWakeLock listeners above (nothing
  // here calls stopPropagation), so a pull also serves as the first-gesture
  // iOS audio unlock same as any other tap.
  const PULL_THRESHOLD_PX = 70;
  const pullIndicatorEl = document.getElementById('pullIndicator');
  let pullBusy = false;
  const pullGate = createPullGate();

  function settlePull(timeoutId) {
    clearTimeout(timeoutId);
    pullBusy = false;
    pullIndicatorEl.classList.remove('show');
  }

  // Reuses the existing stale-reconnect path (connect() closes+recreates es)
  // rather than a bespoke refresh call — same code the visibilitychange
  // watchdog already exercises, so a manual pull is architecturally nothing
  // new. Indicator resolves on the first message/status off the *new* socket
  // (captured right after connect() returns, since es is reassigned
  // synchronously), or a 3s timeout settles it quietly either way.
  function triggerPullRefresh() {
    if (pullBusy || refreshBusy) {
      // A concurrent refresh (button already in flight) means this gesture
      // no-ops — but touchmove already painted "release to refresh" before
      // touchend got here, so it must be cleared here too or the pill sticks
      // until the next unrelated touch.
      pullIndicatorEl.classList.remove('show');
      return;
    }
    pullBusy = true;
    const myPullToken = pullGate.start();
    pullIndicatorEl.textContent = 'refreshing…';
    pullIndicatorEl.classList.add('show');
    const timeoutId = setTimeout(() => settlePull(timeoutId), 3000);
    // Routed through the same refreshReconnect() core the refresh button uses
    // (version-check → reload/connect, in-flight guard) so pull-to-refresh
    // isn't a second bespoke reconnect path. onConnected fires asynchronously
    // (after a network round trip) — if it lands after this pull's own 3s
    // timeout already settled it AND a newer pull has since started,
    // pullGate.isCurrent() rejects it so a stale listener never attaches to
    // someone else's socket and hides their indicator early.
    refreshReconnect((socket) => {
      if (!pullGate.isCurrent(myPullToken)) return;
      const onSettle = () => settlePull(timeoutId);
      socket.addEventListener('message', onSettle, { once: true });
      socket.addEventListener('status', onSettle, { once: true });
    }, () => settlePull(timeoutId));
  }

  if (window.matchMedia('(display-mode: standalone)').matches) {
    let pullStartY = 0;
    let pullActive = false;

    feed.addEventListener('touchstart', (e) => {
      pullActive = feed.scrollTop <= 0;
      pullStartY = e.touches[0].clientY;
    }, { passive: true });

    feed.addEventListener('touchmove', (e) => {
      if (!pullActive) return;
      const deltaY = e.touches[0].clientY - pullStartY;
      const phase = pullPhase(deltaY, PULL_THRESHOLD_PX);
      if (phase === 'idle') {
        // Downward-scroll intent (finger moving up, content moving down) —
        // cancel cleanly and let native scroll take over from here.
        pullActive = false;
        pullIndicatorEl.classList.remove('show');
        return;
      }
      e.preventDefault(); // hold off native rubber-band while our indicator owns the gesture
      pullIndicatorEl.textContent = phase === 'ready' ? '↻ release to refresh' : '↓ pull to refresh';
      pullIndicatorEl.classList.add('show');
    }, { passive: false });

    feed.addEventListener('touchend', (e) => {
      if (!pullActive) return;
      pullActive = false;
      const endY = e.changedTouches[0] ? e.changedTouches[0].clientY : pullStartY;
      if (pullPhase(endY - pullStartY, PULL_THRESHOLD_PX) === 'ready') {
        triggerPullRefresh();
      } else {
        pullIndicatorEl.classList.remove('show');
      }
    });

    // A mid-drag interruption (incoming call, iOS edge-gesture, notification)
    // fires touchcancel instead of touchend — without this the pill can be
    // left stuck visible until the next full drag cycle happens to clear it.
    feed.addEventListener('touchcancel', () => {
      if (!pullActive) return;
      pullActive = false;
      if (!pullBusy) pullIndicatorEl.classList.remove('show');
    });
  }

  // TTS hardening A — any-gesture one-time audio unlock. If the toggle is
  // persisted 'on', a page (re)load / iOS background revival calls no speak()
  // inside a user gesture, so iOS leaves speechSynthesis gated behind a toggle
  // that already reads on. The first tap/click after load fires a silent
  // utterance inside the gesture to unlock, then removes itself. Harmless when
  // the toggle is off (nothing enqueued) and idempotent (runs once).
  let ttsUnlocked = false;
  function unlockTts() {
    if (ttsUnlocked) return;
    ttsUnlocked = true;
    document.removeEventListener('click', unlockTts);
    document.removeEventListener('touchstart', unlockTts);
    if (window.speechSynthesis && speakEnabled) {
      try {
        window.speechSynthesis.resume();
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      } catch {}
    }
  }
  document.addEventListener('click', unlockTts);
  document.addEventListener('touchstart', unlockTts, { passive: true });

  // Persist emit state (floor / spokenIds / lastMsgId) when the page is hidden
  // or unloaded so a hard reload resumes the speak-once ledger instead of
  // re-speaking or flooding.
  window.addEventListener('pagehide', persistEmitState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistEmitState();
  });
})();
</script>
</body>
</html>
`;
}

// ── OBS overlay page ─────────────────────────────────────────────────────
// Read-only SSE consumer. Transparent background, no controls, no
// pull-to-refresh, no service worker, no manifest, no error beacon UI —
// none of the PWA's install/offline machinery makes sense for a browser
// source OBS owns the lifecycle of. `config` arrives pre-validated by
// validateOverlayConfig (lib.js) — every value here is either a validated
// hex color / enum member / bounded int, or a hardcoded default; nothing
// from the raw query string reaches markup or a style block directly.
function overlayHtml(config, myName, token) {
  const fontStack = OVERLAY_FONT_STACKS[config.font] || OVERLAY_FONT_STACKS.system;
  const textShadow = config.outline === 'on'
    ? '0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000'
    : 'none';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="icon" href="/favicon.ico">
<title>Multichat Overlay</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    overflow: hidden;
    font-family: ${fontStack};
    font-size: ${config.fontSize}px;
    color: ${config.text};
  }
  #feed {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    padding: 4px;
    box-sizing: border-box;
  }
  .msg {
    text-shadow: ${textShadow};
    margin: 2px 0;
    padding: 2px 6px;
    border-radius: 4px;
    background: ${config.bg};
    animation: ov-enter 0.2s ease-out;
    width: fit-content;
    max-width: 100%;
    box-sizing: border-box;
  }
  .msg.no-anim { animation: none; }
  @keyframes ov-enter { from { opacity: 0; } to { opacity: 1; } }
  .badge { opacity: 0.7; margin-right: 4px; font-size: 0.8em; text-transform: uppercase; }
  .user { font-weight: bold; margin-right: 4px; color: ${config.text}; }
  .user.mod { color: ${config.mod}; }
  .user.paid { color: ${config.gold}; }
  .user.member { color: ${config.sub}; }
  .mention { color: #fff; background: #c0392b; padding: 0 2px; border-radius: 2px; }
  .amount { color: ${config.gold}; font-weight: bold; margin-right: 4px; }
  .emote { height: 1.4em; vertical-align: middle; }
  .emote.gigantify { height: 2.6em; }
  .gif { display: block; max-height: 96px; max-width: 100%; width: auto; height: auto; border-radius: 6px; margin-top: 4px; }
  .gif-chip { display: inline-block; background: #2a2a32; color: #9a9aa2; border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; margin-top: 2px; }
  .gif-alt { color: #8a8a90; }
  .msg.deleted { text-decoration: line-through; opacity: 0.5; }
  .msg.raid { color: #c58fff; }
  .msg.redeem { color: #4fd1c5; }
  .msg.info { opacity: 0.7; font-style: italic; }
</style>
</head>
<body>
<div id="feed"></div>
<script>
(function() {
'use strict';
const TOKEN = ${jsonForScript(token || '')};
const MY_NAME = ${jsonForScript(myName)};
const CONFIG = ${jsonForScript(config)};
const EMIT_TTL_MS = ${EMIT_TTL_MS};
const feed = document.getElementById('feed');

${roleClass}
const EMOTE_ID_RE = ${EMOTE_ID_RE};
const ALLOWED_EMOJI_HOST_RE = ${ALLOWED_EMOJI_HOST_RE};
const ALLOWED_GIF_HOST_RE = ${ALLOWED_GIF_HOST_RE};
${isAllowedEmojiUrl}
${isAllowedGifUrl}
${renderGifToken}
${mergeAnnotations}
${appendWithMention}
${renderText}
${buildRow}
${cleanSpokenName}
${normalizeSpokenMentions}
${formatUtterance}
${formatOverlayUtterance}
${enqueueCapped}
${supersedeSocket}
${markMatchesQueueItem}

// ── Speak-once ledger — SEPARATE key from the PWA's 'multichat-spoken'
// (item 7: same origin, unnamespaced keys would let the two surfaces
// cross-suppress each other's spoken ids). Same shape/mechanism as the
// PWA's own floor+spokenIds+EMIT_TTL_MS predicate, just not the shared
// isEmittable() itself — that function's category gate is fixed to the
// PWA's financial/raid/silent split, but the overlay's own category
// decision is config.tts-driven (shouldSpeak below), so the three
// floor/spokenIds/TTL terms are inlined here instead.
const OV_SPOKEN_KEY = 'multichat-ov-spoken';
let emitFloor = 0;
let spokenIds = new Map();
try {
  const stored = JSON.parse(localStorage.getItem(OV_SPOKEN_KEY) || 'null');
  if (stored && typeof stored.floor === 'number') {
    emitFloor = stored.floor;
    const now = Date.now();
    for (const [id, ts] of (stored.ids || [])) {
      if (now - ts < EMIT_TTL_MS) spokenIds.set(id, ts);
    }
  }
} catch {}
function persistOverlaySpoken() {
  try { localStorage.setItem(OV_SPOKEN_KEY, JSON.stringify({ floor: emitFloor, ids: [...spokenIds] })); } catch {}
}
function pruneSpokenOverlay(now) {
  for (const [id, ts] of spokenIds) { if (now - ts >= EMIT_TTL_MS) spokenIds.delete(id); }
}
window.addEventListener('pagehide', persistOverlaySpoken);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistOverlaySpoken();
});

// ── Row lifecycle ──────────────────────────────────────────────────────
let lastMsgId = 0;

function insertRow(row) {
  if (CONFIG.order === 'newest-top') {
    feed.insertBefore(row, feed.firstChild);
  } else {
    feed.appendChild(row);
  }
  while (feed.childElementCount > CONFIG.maxRows) {
    feed.removeChild(CONFIG.order === 'newest-top' ? feed.lastChild : feed.firstChild);
  }
  if (CONFIG.rowTtlSec > 0) {
    setTimeout(() => { row.remove(); }, CONFIG.rowTtlSec * 1000);
  }
}

function handleMsg(msg) {
  // B3: replay:true suppresses the entry animation ONLY. TTS suppression is
  // governed entirely by the floor+spokenIds+EMIT_TTL_MS predicate in
  // maybeSpeak below — a message that arrives tagged replay after a
  // transient reconnect (the only case that ever carries the flag — a
  // fresh load gets zero ring rows at all) may still be genuinely unheard
  // and should still speak.
  const isReplay = Boolean(msg.replay);
  if (typeof msg.id === 'number') lastMsgId = msg.id;
  const row = buildRow(msg, { myName: MY_NAME, roleClass, doc: document, mention: true, gifsAsAlt: CONFIG.gifAlt === 'on' });
  if (!row) return;
  if (isReplay) row.classList.add('no-anim');
  insertRow(row);
  maybeSpeak(msg);
}

// ── TTS queue ────────────────────────────────────────────────────────────
let ttsQueue = []; // {text, twId, login, ytId, authorId}
let ttsPlaying = false;
let currentAudio = null;
let currentAudioItem = null;
// Cancellation for "deleted must mean unspoken" against the CURRENT item
// specifically — two failure modes this closes, both real:
//   1. A mark matching the in-flight /tts fetch (before currentAudio even
//      exists) used to be silently swallowed by the old "if (currentAudio
//      and ...)" guard -- the audio would still play once the fetch
//      resolved. currentCancelled is checked right after both awaits in
//      pumpQueue, closing that window.
//   2. audio.pause() does NOT fire 'onended'/'onerror' — a mark arriving
//      mid-playback that only called pause() left the pending Promise
//      forever unresolved, permanently stalling the whole queue
//      (ttsPlaying stuck true). currentResolvePlayback lets the mark
//      handler resolve that Promise itself.
let currentCancelled = false;
let currentResolvePlayback = null;

function isFinancial(msg) {
  return Boolean(msg.kind) && msg.kind !== 'member_gift_received';
}

// "Body is spoken ONLY for financial rows. Never for regular chat, never
// for raids, never for system rows, regardless of the tts=all setting."
function shouldSpeak(msg) {
  if (CONFIG.tts === 'off') return false;
  if (msg.sys) return false;
  if (isFinancial(msg)) return true; // tts:financial or tts:all, either speaks financial rows
  return CONFIG.tts === 'all'; // plain chat only under tts:all
}

function utteranceFor(msg) {
  if (isFinancial(msg)) {
    return formatOverlayUtterance(msg, { speakBody: CONFIG.ttsBody === 'on' });
  }
  const body = normalizeSpokenMentions(msg.text || '');
  return body ? cleanSpokenName(msg.user) + ' says ' + body : '';
}

function maybeSpeak(msg) {
  if (!shouldSpeak(msg)) return;
  if (typeof msg.id !== 'number') return;
  const now = Date.now();
  if (!(msg.id > emitFloor && !spokenIds.has(msg.id) && now - (msg.ts || now) < EMIT_TTL_MS)) return;
  spokenIds.set(msg.id, now);
  pruneSpokenOverlay(now);
  emitFloor = msg.id;
  persistOverlaySpoken();
  const text = utteranceFor(msg);
  if (!text) return;
  const item = { text, twId: msg.twId, login: msg.login, ytId: msg.ytId, authorId: msg.authorId };
  ttsQueue = enqueueCapped(ttsQueue, item, 3); // depth 3, drop-oldest
  pumpQueue();
}

async function pumpQueue() {
  if (ttsPlaying) return;
  const item = ttsQueue.shift();
  if (!item) return;
  ttsPlaying = true;
  currentAudioItem = item;
  currentCancelled = false;
  try {
    const res = await fetch('/tts?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: item.text }),
    });
    if (currentCancelled) return; // deleted while the /tts fetch itself was in flight
    // /tts fails silent (204, no body) on kill/throttle/budget/any error —
    // this queue mirrors that: no audio, no visible error, just move on.
    if (res.ok && res.status !== 204) {
      const blob = await res.blob();
      if (currentCancelled) return; // deleted while decoding the audio blob
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = CONFIG.ttsVolume / 100;
      currentAudio = audio;
      await new Promise((resolve) => {
        currentResolvePlayback = resolve;
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      currentResolvePlayback = null;
      URL.revokeObjectURL(url);
    }
  } catch {
    // fail silent client-side too
  } finally {
    currentAudio = null;
    currentAudioItem = null;
    currentResolvePlayback = null;
    ttsPlaying = false;
    pumpQueue();
  }
}

// ── SSE connection — same reconnect shape as the PWA's connect(), trimmed:
// no banner/stale-indicator UI, no pull-to-refresh, no watchdog alarm ping
// handling (the overlay doesn't need a "connection looks dead" UI state,
// just keep retrying quietly). Never suppresses Last-Event-ID — a native
// EventSource sets it automatically on its own auto-reconnect, and per B3
// that's exactly the case that SHOULD speak, just not animate.
let es = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
  reconnectAttempt++;
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  clearTimeout(reconnectTimer);
  supersedeSocket(es);
  const url = '/events?t=' + encodeURIComponent(TOKEN) + (lastMsgId ? '&lastEventId=' + lastMsgId : '');
  const socket = new EventSource(url);
  es = socket;
  socket.onopen = () => { if (socket === es) reconnectAttempt = 0; };
  socket.onmessage = (e) => {
    if (socket !== es) return;
    try { handleMsg(JSON.parse(e.data)); } catch {}
  };
  // Mirrors the PWA's own mark listener field-for-field (worker.js) — plus
  // dropping any queued/currently-playing utterance whose row this
  // identifies ("deleted must mean unspoken", including mid-playback).
  socket.addEventListener('mark', (e) => {
    if (socket !== es) return;
    try {
      const m = JSON.parse(e.data);
      ttsQueue = ttsQueue.filter((item) => !markMatchesQueueItem(m, item));
      if (currentAudioItem && markMatchesQueueItem(m, currentAudioItem)) {
        currentCancelled = true;
        if (currentAudio) currentAudio.pause();
        // pause() does NOT fire onended/onerror -- without explicitly
        // resolving here, a strike mid-playback would permanently stall
        // the queue (ttsPlaying stuck true forever). If playback hasn't
        // started yet (still awaiting the /tts fetch itself), there's
        // nothing to resolve yet -- currentCancelled alone covers that
        // window, checked right after the fetch/blob awaits in pumpQueue.
        if (currentResolvePlayback) currentResolvePlayback();
      }
      let sel = null;
      if (m.action === 'delete') {
        sel = m.platform === 'yt'
          ? (m.targetId ? '[data-ytid="' + CSS.escape(m.targetId) + '"]' : null)
          : (m.targetId ? '[data-twid="' + CSS.escape(m.targetId) + '"]' : null);
      } else if (m.action === 'author_delete') {
        sel = m.authorId ? '[data-ytauthor="' + CSS.escape(m.authorId) + '"]' : null;
      } else if (m.action === 'supersede') {
        sel = m.targetId ? '[data-twid="' + CSS.escape(m.targetId) + '"]' : null;
      } else {
        sel = m.login ? '[data-login="' + CSS.escape(m.login) + '"]' : null;
      }
      if (sel) {
        feed.querySelectorAll(sel).forEach((r) => {
          if (m.action === 'supersede') r.remove(); else r.classList.add('deleted');
        });
      }
    } catch {}
  });
  socket.onerror = () => {
    if (socket !== es) return;
    if (socket.readyState === EventSource.CLOSED) scheduleReconnect();
  };
}

connect();
})();
</script>
</body>
</html>
`;
}

// ── Overlay config builder page ──────────────────────────────────────────
// Opened in a real browser, never added to an OBS scene. Live preview of a
// few fake rows plus one control per OVERLAY_PARAM_SPEC entry, emitting the
// finished /overlay URL to paste into OBS. Imports the SAME spec /overlay
// itself validates against, so the two cannot drift.
function overlayConfigHtml(token) {
  const controlsHtml = Object.entries(OVERLAY_PARAM_SPEC).map(([key, spec]) => {
    if (spec.type === 'color') {
      return `<label>${key} <input type="color" data-key="${key}" data-type="color" value="${spec.default}"></label>`;
    }
    if (spec.type === 'enum') {
      const opts = spec.values.map((v) => `<option value="${v}"${v === spec.default ? ' selected' : ''}>${v}</option>`).join('');
      return `<label>${key} <select data-key="${key}" data-type="enum">${opts}</select></label>`;
    }
    return `<label>${key} <input type="number" data-key="${key}" data-type="int" min="${spec.min}" max="${spec.max}" value="${spec.default}"></label>`;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="icon" href="/favicon.ico">
<title>Multichat Overlay Config</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16161c; color: #e8e8ea; padding: 16px; }
  label { display: block; margin: 6px 0; font-size: 14px; }
  input, select { margin-left: 6px; }
  #previewWrap { background: repeating-conic-gradient(#222 0% 25%, #2a2a2a 0% 50%) 0 0 / 20px 20px; padding: 8px; margin: 12px 0; border-radius: 6px; }
  #preview { min-height: 120px; padding: 4px; }
  /* Same structural rules as /overlay itself (worker.js's overlayHtml) —
     only the per-config bits (colors/font/outline) are driven by JS below,
     via applyColorVars/renderPreview, matching how /overlay applies config. */
  #preview .msg { margin: 2px 0; padding: 2px 6px; border-radius: 4px; width: fit-content; max-width: 100%; box-sizing: border-box; }
  #preview .badge { opacity: 0.7; margin-right: 4px; font-size: 0.8em; text-transform: uppercase; }
  #preview .user { font-weight: bold; margin-right: 4px; }
  #preview .amount { font-weight: bold; margin-right: 4px; }
  #preview .emote { height: 1.4em; vertical-align: middle; }
  #preview .emote.gigantify { height: 2.6em; }
  #preview .gif { display: block; max-height: 96px; max-width: 100%; width: auto; height: auto; border-radius: 6px; margin-top: 4px; }
  #preview .gif-chip { display: inline-block; background: #2a2a32; color: #9a9aa2; border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; margin-top: 2px; }
  #preview .gif-alt { color: #8a8a90; }
  #preview .msg.deleted { text-decoration: line-through; opacity: 0.5; }
  #preview .mention { color: #fff; background: #c0392b; padding: 0 2px; border-radius: 2px; }
  #urlOut { width: 100%; font-family: monospace; padding: 6px; margin-top: 8px; box-sizing: border-box; }
</style>
</head>
<body>
<h2>Multichat Overlay Config</h2>
<p>Adjust settings, copy the URL below into an OBS Browser Source. This page itself is never added to a scene.</p>
<div id="controls">
${controlsHtml}
</div>
<h3>Preview (fake rows, not live chat)</h3>
<div id="previewWrap"><div id="preview"></div></div>
<textarea id="urlOut" rows="3" readonly></textarea>
<script>
(function() {
'use strict';
const TOKEN = ${jsonForScript(token || '')};
const controls = document.querySelectorAll('#controls [data-key]');
const preview = document.getElementById('preview');
const urlOut = document.getElementById('urlOut');

${roleClass}
const EMOTE_ID_RE = ${EMOTE_ID_RE};
const ALLOWED_EMOJI_HOST_RE = ${ALLOWED_EMOJI_HOST_RE};
const ALLOWED_GIF_HOST_RE = ${ALLOWED_GIF_HOST_RE};
${isAllowedEmojiUrl}
${isAllowedGifUrl}
${renderGifToken}
${mergeAnnotations}
${appendWithMention}
${renderText}
${buildRow}

// Representative fixed sample rows -- plain, mod, financial/gold, emote,
// mention, deleted -- same spread as the buildRow golden fixture, so the
// preview exercises every color slot the controls above actually affect.
const FAKE_MSGS = [
  { platform: 'twitch', user: 'viewer1', text: 'hello chat' },
  { platform: 'twitch', user: 'modperson', text: 'settle down', isMod: true },
  { platform: 'twitch', user: 'baller', text: 'take my bits', kind: 'cheer', amount: '500 bits' },
  { platform: 'twitch', user: 'viewer2', text: 'Kappa', emotes: [{ id: '25', start: 0, end: 4 }] },
  { platform: 'twitch', user: 'gifposter', text: '[nice GIF]', gifs: [{ start: 0, end: 9, id: 'abc123', url: 'https://media.giphy.com/media/abc123/giphy.gif' }] },
  { platform: 'twitch', user: 'friend', text: 'hey streamer check this out' },
  { platform: 'twitch', user: 'deletedguy', text: 'this got removed', deleted: true },
];

function applyColorVars(config) {
  const root = document.documentElement.style;
  root.setProperty('--ov-bg', config.bg);
  preview.style.color = config.text;
  preview.style.fontFamily = config.font === 'mono' ? 'monospace' : config.font === 'serif' ? 'serif' : 'inherit';
  preview.style.fontSize = config.fontSize + 'px';
  preview.style.textShadow = config.outline === 'on' ? '0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000' : 'none';
  document.getElementById('previewWrap').style.background = config.bg === '#0b0b0f'
    ? '' // keep the checkerboard for the default transparent-ish bg so it stays legible against any scene
    : config.bg;
}

function currentConfig() {
  const config = {};
  controls.forEach((el) => { config[el.dataset.key] = el.value; });
  return config;
}

function renderPreview() {
  const config = currentConfig();
  applyColorVars(config);
  preview.textContent = '';
  const rows = config.order === 'newest-top' ? [...FAKE_MSGS].reverse() : FAKE_MSGS;
  for (const msg of rows) {
    const row = buildRow(msg, { myName: 'streamer', roleClass, doc: document, mention: true, gifsAsAlt: config.gifAlt === 'on' });
    if (row) {
      row.style.background = config.bg;
      row.style.textShadow = config.outline === 'on' ? '0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000' : 'none';
      if (row.querySelector('.user.mod')) row.querySelector('.user.mod').style.color = config.mod;
      if (row.querySelector('.user.paid')) row.querySelector('.user.paid').style.color = config.gold;
      const amt = row.querySelector('.amount');
      if (amt) amt.style.color = config.gold;
      preview.appendChild(row);
    }
  }
}

function buildUrl() {
  const params = new URLSearchParams();
  if (TOKEN) params.set('t', TOKEN);
  controls.forEach((el) => { params.set(el.dataset.key, el.value); });
  return location.origin + '/overlay?' + params.toString();
}

function refresh() {
  urlOut.value = buildUrl();
  renderPreview();
}

controls.forEach((el) => el.addEventListener('input', refresh));
refresh();
})();
</script>
</body>
</html>
`;
}
