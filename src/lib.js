// Plain-VALUE constants that must live outside the Worker's entry module.
//
// workerd validates that every top-level named export of the ENTRY module
// (the file wrangler.jsonc's `main` points at) is a function, class, or
// ExportedHandler-shaped object — a named export can be an RPC/named-
// entrypoint target, so anything else fails local-dev boot with e.g.
// "Incorrect type for map entry 'EMIT_TTL_MS': the provided value is not of
// type 'function or ExportedHandler'." This is a workerd-binary-level check
// (no wrangler.jsonc/compatibility_date flag relaxes it) and does NOT apply
// to non-entry modules like this one — see cloudflare/workers-sdk#10213.
//
// worker.js's own `export function`/`export class ChatHub` are fine as-is
// (functions/classes are allowed entry-module exports); only the handful of
// plain constants below ever needed to move. Import them here rather than
// defining them in worker.js so `wrangler dev` boots while vitest can still
// import them directly for unit tests.

// Outer bound on how long a yt message can lag its own mod-action delete
// (see resolvePendingYtMod in worker.js), and the bounded per-map cap for
// pendingYtDeletes/pendingAuthorDeletes (oldest-by-insertion evicted first).
export const PENDING_MOD_TTL_MS = 5 * 60_000;
export const PENDING_MOD_MAX = 64;

// Heuristic correlation window between a channel.bits.use gigantify_an_emote
// event and the plain IRC PRIVMSG it accompanies — no id correlates the two
// (see docs/ARCHITECTURE.md §3a), so this bounds how long either side waits
// for its match before giving up. Deliberately short: a real gigantify's
// PRIVMSG and EventSub notification arrive within the same second in
// practice, and a long window would risk matching an unrelated later message
// from the same user.
export const GIGANTIFY_SUPPRESS_WINDOW_MS = 10_000;

// YouTube member_* kinds are announcement events the poller identifies by
// renderer type (its patched youtube-chat parser) — never by the isMembership
// badge flag, which is true on every message from any existing member. The
// isMember badge (see normalizeYt in worker.js) remains the membership-status
// signal.
export const VALID_KINDS = new Set([
  'cheer', 'sub', 'giftsub',
  'superchat', 'supersticker',
  'member_new', 'member_milestone', 'member_gift', 'member_gift_received', 'member_renewed',
  'yt_gift',
  'power_up',
]);

// Financial/paid subset of VALID_KINDS, for the enumerable per-event server
// log line. Excludes member_gift_received (redemption noise — a gift bomb is
// one member_gift plus up to 20 redemptions). Derived rather than
// hand-restated so a new VALID_KINDS entry can't silently miss this set.
export const FINANCIAL_KINDS = new Set([...VALID_KINDS].filter((k) => k !== 'member_gift_received'));

// Speech label per financial `kind` — kept separate from the on-screen
// badge/text so YouTube's "gift" and Twitch's community-gift burst, which
// render similarly, are disambiguated out loud. Falls back to the raw kind
// string for anything unmapped rather than going silent (see TTS_LABELS
// coverage test — a new VALID_KINDS entry without a label fails it).
export const TTS_LABELS = {
  cheer: 'cheer',
  sub: 'sub',
  giftsub: 'gift sub',
  superchat: 'superchat',
  supersticker: 'super sticker',
  member_new: 'new member',
  member_milestone: 'member milestone',
  member_gift: 'gifted memberships',
  member_renewed: 'renewed member',
  yt_gift: 'gift',
  power_up: 'power-up',
};

// Age cap on emission. A persisted (and possibly stale) floor must never let a
// day-old ring replay flood the buzzer/synth on load — only rows at least this
// recent can still fire. Shared by the client predicate and its test.
export const EMIT_TTL_MS = 30 * 60_000;

// Spoken-name cleanup for TTS only — see the internal dry-run notes
// (2026-08-05) for the approved regex and the deferred Step2 (separator-segment strip,
// e.g. darc-ttv -> darc) this deliberately does NOT implement yet. Strips a
// trailing digit run, absorbing one immediately-preceding `_`/`-` in the same
// match so `cool_guy_99` -> `cool_guy` rather than leaving a dangling
// separator. Guards against over-stripping an identity down to nothing or
// near-nothing (an all-digit name, or a 1-char remainder) by returning the
// original name unchanged in that case.
export function cleanSpokenName(name) {
  // Leading-@ strip runs FIRST, before the digit strip and before the
  // <2-char guard below -- so a chat client that carries a raw "@Jon_123"
  // into msg.user (rather than "Jon_123") still ends up read aloud as
  // "Jon", not "at Jon underscore one two three". Never returns empty:
  // deAt falls back to the ORIGINAL name if stripping leading @s alone
  // would empty the string (a bare "@"), and the final guard falls back to
  // deAt (not all the way to the un-stripped name) once deAt is known
  // non-empty -- so "@x" cleans to "x", not "@x".
  const deAt = name.replace(/^@+/, '');
  const base = deAt.length > 0 ? deAt : name;
  const cleaned = base.replace(/[_-]?\d+$/, '');
  return cleaned.length < 2 ? base : cleaned;
}

// Spoken-output-only mention normalization: strips the '@' off an in-text
// mention ("hey @Jon thanks" -> "hey Jon thanks") so it reads as the name,
// not "at Jon". Deliberately narrow -- only an @ immediately preceded by
// start-of-string or whitespace counts as a mention marker, so an email
// address embedded in text ("a@b.com") is never touched: its '@' is
// preceded by a non-whitespace character ('a'), so the pattern doesn't
// match there at all. Only the '@' itself is consumed (\S matches exactly
// one character) -- the rest of the mentioned name is untouched literal
// text, never re-parsed. Not currently wired into any call site -- see
// gate-2 report / open question on where a "speak the message body" TTS
// path (if one gets built) should invoke this.
export function normalizeSpokenMentions(text) {
  return text.replace(/(^|\s)@(\S)/g, '$1$2');
}

// ── Overlay spoken-body pipeline ────────────────────────────────────────────
// Financial-row message bodies, opt-in via the overlay's ttsBody param
// (default OFF — see OVERLAY_PARAM_SPEC below), never spoken for chat/raid/
// sys rows. See formatOverlayUtterance in worker.js for the call site and the
// degrade-to-formatUtterance-on-empty-body contract.

// ASCII control characters (0x00-0x1F, 0x7F) never reach the synthesizer —
// TTS-only hardening against control-char injection via a donation message.
export function stripControlChars(text) {
  return text.replace(/[\x00-\x1F\x7F]/g, '');
}

// A URL read aloud character-by-character is useless noise and a vector for
// smuggling arbitrary spoken-looking content into a donation message.
export function stripUrls(text) {
  return text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

// "soooooo good" -> "sooo good". Caps a repeated-character run at 3 so a
// message engineered to make the TTS engine drone on one sound can't, without
// altering ordinary short repeats ("cool", "yesss").
export function collapseRepeatedChars(text) {
  return text.replace(/(.)\1{3,}/g, '$1$1$1');
}

// Full pipeline, in this order: control chars -> URLs -> repeat-collapse ->
// mention normalize -> hard length cap. The 120-char cap is the BODY's own
// budget, separate from and smaller than /tts's own 200-char whole-utterance
// cap (worker.js handleTts) — capping the body here first means a long
// donation message can never truncate the name/amount prefix out of the
// utterance; only the body itself gets cut. Returns '' (never throws) if
// nothing speakable survives (e.g. a message that was only a URL) — the
// caller (formatOverlayUtterance) treats '' as "no body" and degrades to
// exactly formatUtterance's own PWA-equivalent line, never a broken or
// silent utterance.
export function sanitizeSpokenBody(text, maxLen = 120) {
  if (!text) return '';
  let out = stripControlChars(text);
  out = stripUrls(out);
  out = collapseRepeatedChars(out);
  out = normalizeSpokenMentions(out);
  out = out.trim();
  return out.length > maxLen ? out.slice(0, maxLen).trim() : out;
}

// ── Overlay TTS queue: mod-action drop ──────────────────────────────────────
// "Deleted must mean unspoken." A queued utterance carries the same identity
// fields buildRow already stamps onto its row (dataset.twid/login/ytid/
// ytauthor) — this mirrors the PWA's own mark-listener branching
// (worker.js's socket.addEventListener('mark', ...)) field-for-field, just
// matching against a queue item's stored identity instead of a CSS selector
// against a live DOM row. Any action match (including 'supersede', the
// gigantify double-display case) means "don't speak this."
export function markMatchesQueueItem(mark, item) {
  if (mark.action === 'delete') {
    return mark.platform === 'yt'
      ? Boolean(mark.targetId) && item.ytId === mark.targetId
      : Boolean(mark.targetId) && item.twId === mark.targetId;
  }
  if (mark.action === 'author_delete') {
    return Boolean(mark.authorId) && item.authorId === mark.authorId;
  }
  if (mark.action === 'supersede') {
    return Boolean(mark.targetId) && item.twId === mark.targetId;
  }
  // timeout/ban fallback — same as the PWA's own else-branch
  return Boolean(mark.login) && item.login === mark.login;
}

// ── Overlay param validation ────────────────────────────────────────────────
// Single source of truth for both /overlay (which enforces this) and
// /overlay/config (which renders controls from it) — importing the same
// spec is what keeps the two from drifting. Every value is validated
// strictly server-side before it can touch markup or a style block; an
// invalid param falls back to `default`, never a 500.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const OVERLAY_FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"SF Mono", Consolas, "Courier New", monospace',
  rounded: '"Comic Sans MS", "Comic Sans", cursive, sans-serif',
  condensed: '"Arial Narrow", Arial, sans-serif',
  impact: 'Impact, Haettenschweiler, sans-serif',
};

export const OVERLAY_PARAM_SPEC = {
  bg: { type: 'color', default: '#0b0b0f' },
  text: { type: 'color', default: '#e8e8ea' },
  name: { type: 'color', default: '#9b9bff' },
  gold: { type: 'color', default: '#ffd54a' },
  mod: { type: 'color', default: '#5ac8fa' },
  sub: { type: 'color', default: '#6bcf6b' },
  font: { type: 'enum', values: Object.keys(OVERLAY_FONT_STACKS), default: 'system' },
  fontSize: { type: 'int', min: 12, max: 72, default: 20 },
  maxRows: { type: 'int', min: 5, max: 100, default: 30 },
  rowTtlSec: { type: 'int', min: 0, max: 600, default: 0 },
  order: { type: 'enum', values: ['newest-top', 'newest-bottom'], default: 'newest-bottom' },
  outline: { type: 'enum', values: ['on', 'off'], default: 'on' },
  tts: { type: 'enum', values: ['off', 'financial', 'all'], default: 'financial' },
  ttsVolume: { type: 'int', min: 0, max: 100, default: 80 },
  // Off by default — a moderation surface a viewer can pay to have spoken
  // aloud gets probed; the scene operator opts in deliberately, per scene.
  ttsBody: { type: 'enum', values: ['on', 'off'], default: 'off' },
  // ON by default — a public OBS scene is a broadcast surface, same
  // opt-in-not-opt-out posture as ttsBody just above: GIF images stay off
  // (alt text only) until the scene operator explicitly sets gifAlt=off,
  // per scene. Independent of the PWA's own gifsEnabled toggle, which
  // stays default-on regardless of this param. See renderGifToken's
  // asAltOnly param above.
  gifAlt: { type: 'enum', values: ['on', 'off'], default: 'on' },
};

// Validates one raw query-param string against its OVERLAY_PARAM_SPEC entry.
// Returns { value, rejected } — rejected:true means the raw input was
// present but invalid (caller logs one ev line per rejection), NOT that the
// param was simply absent (absent is the ordinary default path, not a
// rejection worth logging).
export function validateOverlayParam(key, raw) {
  const spec = OVERLAY_PARAM_SPEC[key];
  if (!spec) return { value: undefined, rejected: false };
  if (raw == null) return { value: spec.default, rejected: false };
  if (spec.type === 'color') {
    return HEX_COLOR_RE.test(raw) ? { value: raw, rejected: false } : { value: spec.default, rejected: true };
  }
  if (spec.type === 'enum') {
    return spec.values.includes(raw) ? { value: raw, rejected: false } : { value: spec.default, rejected: true };
  }
  if (spec.type === 'int') {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < spec.min || n > spec.max) {
      return { value: spec.default, rejected: true };
    }
    return { value: n, rejected: false };
  }
  return { value: spec.default, rejected: true };
}

// Validates every OVERLAY_PARAM_SPEC key from a URLSearchParams-like object
// (anything with .get(key)) in one pass. Returns { config, rejections } —
// rejections is a list of {key, raw} for the caller's single ev log line per
// bad param (never a 500, per item 3's contract).
export function validateOverlayConfig(searchParams) {
  const config = {};
  const rejections = [];
  for (const key of Object.keys(OVERLAY_PARAM_SPEC)) {
    const raw = searchParams.get(key);
    const { value, rejected } = validateOverlayParam(key, raw);
    config[key] = value;
    if (rejected) rejections.push({ key, raw });
  }
  return { config, rejections };
}

// ── Ingest-tail instrumentation ────────────────────────────────────────────
// Module-level, not instance state: survives across requests within one
// isolate's lifetime, same scope as the consts above. Tracks every awaited
// outbound fetch's span_id -> {op, start} so an ingest request's handler
// window (see ChatHub.handleIngestYt) can be correlated against whatever
// fetch spans were in flight at any point during it — the actual test of
// the DO input-gate hypothesis. Added on span start, removed in the same
// finally that logs the span (never left dangling on error).
export const inFlightSpans = new Map();

export function beginFetchSpan(op) {
  const spanId = crypto.randomUUID().slice(0, 8);
  inFlightSpans.set(spanId, { op, start: Date.now() });
  return spanId;
}

export function endFetchSpan(spanId, outcome) {
  const span = inFlightSpans.get(spanId);
  inFlightSpans.delete(spanId);
  const start = span ? span.start : Date.now();
  const op = span ? span.op : 'unknown';
  console.log(JSON.stringify({ ev: 'do_fetch_timing', op, durationMs: Date.now() - start, outcome, span_id: spanId }));
}

// Copies whatever spans are currently open into `into` (keyed by span_id,
// keeping the earliest-seen {op, start} — same Map entry object each time,
// so a second call mid-request just re-adds what's still there). Called
// once before and once after the ingest handler's only await point — a span
// that opens AND fully closes strictly between those two checks, without
// ever showing up in either snapshot, cannot be caught this way.
export function snapshotOpenSpans(into) {
  for (const [spanId, span] of inFlightSpans) into.set(spanId, span);
}

// Collapses the begin/try/fetch/mark-ok/finally/end boilerplate repeated at
// every call site where the span scope is JUST the fetch call itself (res
// assigned to an outer variable, all res.ok/status/json handling happens
// after this returns). Two call sites in worker.js — recoverGap's 'backfill'
// and pollTwitchViewers' 'helix_viewer_poll' — have span scope that also
// covers early-return control flow reaching outside the fetch itself, and
// stay hand-rolled rather than forcing that control flow through a callback.
export async function spannedFetch(op, fn) {
  const spanId = beginFetchSpan(op);
  let fetchOutcome = 'error';
  try {
    const result = await fn();
    fetchOutcome = 'ok';
    return result;
  } finally {
    endFetchSpan(spanId, fetchOutcome);
  }
}

// ── Shared row renderer ─────────────────────────────────────────────────────
// Used by both the PWA (worker.js's addRow, via the toString() interpolation
// at pageHtml's TTS block) and the /overlay page — one renderer, not two.
// Pure by construction: every input arrives via `msg`/`opts`, nothing is
// closed over. `doc` is always injected (never a bare `document` reference)
// so a stray server-side call throws ReferenceError immediately under
// workerd/vitest instead of silently doing nothing — see
// test/buildrow-parity.test.js's "never touches global document" case.

export const EMOTE_ID_RE = /^[A-Za-z0-9_]+$/;
// Client-side re-check of the worker's emoji-host allowlist (defense in
// depth — the worker already blanks disallowed urls at ingest, so this is a
// belt-and-suspenders check, not the authoritative gate).
export const ALLOWED_EMOJI_HOST_RE = /(^|\.)(ggpht\.com|googleusercontent\.com|gstatic\.com)$/;

export function isAllowedEmojiUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_EMOJI_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

// Client-side re-check of the worker's giphy-host allowlist — same
// defense-in-depth relationship to isAllowedGifHost (worker.js) as
// isAllowedEmojiUrl above has to the YT allowlist: the worker already drops
// disallowed urls at parse time, this is belt-and-suspenders.
export const ALLOWED_GIF_HOST_RE = /^media\d*\.giphy\.com$/;

export function isAllowedGifUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_GIF_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

// Splits a plain-text chunk on case-insensitive myName occurrences and
// appends each as text except the match itself, which gets a mention
// span (white text on red) — only the name is highlighted, not the row.
// myName === '' (falsy) no-ops, same as the PWA's disabled-highlighting case;
// buildRow uses this to let opts.mention:false suppress highlighting without
// a branch of its own.
export function appendWithMention(container, str, myName, doc) {
  if (!str) return;
  if (!myName) { container.append(str); return; }
  const lower = str.toLowerCase();
  let i = 0;
  let idx;
  while ((idx = lower.indexOf(myName, i)) !== -1) {
    if (idx > i) container.append(str.slice(i, idx));
    const span = doc.createElement('span');
    span.className = 'mention';
    span.textContent = str.slice(idx, idx + myName.length);
    container.append(span);
    i = idx + myName.length;
  }
  if (i < str.length) container.append(str.slice(i));
}

// Renders a gif range's token (the full bracketed alt text, e.g. "[Y A Y
// Yes GIF by Djemilah Birnie]") — absent/rejected url degrades to plain gray
// text (the worker already blanked a disallowed-host url before this ever
// arrives; isAllowedGifUrl is the client-side belt-and-suspenders re-check).
// asAltOnly (the overlay's gifAlt config flag, default ON — OVERLAY_PARAM_SPEC
// in this file) forces the alt-text branch unconditionally, regardless of
// url/gifsEnabled — a scene operator must opt OUT (gifAlt=off) to see
// images at all, distinct from the PWA's
// gifsEnabled tap-to-load toggle. gifsEnabled false (PWA only; the overlay
// never passes this) renders a tappable [GIF] chip that loads the image only
// on tap (IRL cellular bandwidth — GIFs are multi-MB and Twitch forbids
// picking a smaller rendition), never eagerly.
//
// The <img>-building block below is duplicated (eager branch + chip's
// onclick) rather than factored into a shared local closure — deliberate,
// not an oversight. A named local closure here (a `const buildImg = () =>
// {}` this used to be) gets wrapped by esbuild's production minifier in its
// own `__name()` runtime helper, which only exists in the SERVER's bundle;
// this function's whole body is re-embedded client-side via
// Function.prototype.toString() (${renderGifToken} in worker.js), so that
// call becomes a silent client-side ReferenceError (swallowed by
// socket.onmessage's catch {}) — confirmed live, 2026-09-03 incident, see
// test/bundle-gif-render.test.js. Do not reintroduce a named local closure
// here without re-running that test against a real `wrangler deploy
// --dry-run` bundle first.
export function renderGifToken(container, token, url, doc, gifsEnabled, asAltOnly) {
  if (asAltOnly || !url || !isAllowedGifUrl(url)) {
    const span = doc.createElement('span');
    span.className = 'gif-alt';
    span.textContent = token;
    container.append(span);
    return;
  }
  if (gifsEnabled) {
    const img = doc.createElement('img');
    img.className = 'gif';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = token;
    img.src = url;
    img.onerror = () => { img.replaceWith(doc.createTextNode(token)); };
    container.append(img);
    return;
  }
  const chip = doc.createElement('span');
  chip.className = 'gif-chip';
  chip.textContent = '[GIF]';
  chip.tabIndex = 0;
  chip.onclick = () => {
    const img = doc.createElement('img');
    img.className = 'gif';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = token;
    img.src = url;
    img.onerror = () => { img.replaceWith(doc.createTextNode(token)); };
    chip.replaceWith(img);
  };
  container.append(chip);
}

// Merges msg.emotes and msg.gifs into one start-sorted annotation list so a
// single code-point walk below can splice both — both are the same shape
// (Unicode code-point offsets, end INCLUSIVE; see parseEmotes/parseGifs and
// sanitizeYtEmotes in worker.js). isGif tags a gif entry so the walk below
// knows which branch to render.
export function mergeAnnotations(emotes, gifs) {
  const merged = [
    ...(emotes || []),
    ...(gifs || []).map((g) => ({ ...g, isGif: true })),
  ];
  merged.sort((a, b) => a.start - b.start);
  return merged;
}

// id (Twitch) / url (YouTube custom emoji, Twitch gif) are untrusted tag
// data and the first such values to leave textContent — both are validated
// before they can reach img.src; an invalid id or disallowed-host url falls
// back to plain text. DOM node building only, never innerHTML.
export function renderText(container, text, emotes, { myName, doc, gifs, gifsEnabled, gifsAsAlt }) {
  const merged = mergeAnnotations(emotes, gifs);
  if (!merged.length) {
    appendWithMention(container, text, myName, doc);
    return;
  }
  const cps = [...text];
  let cursor = 0;
  for (const item of merged) {
    const { id, start, end, url, alt, isGif } = item;
    if (start < cursor || start >= cps.length) continue; // out-of-range/overlapping — ignore
    if (start > cursor) appendWithMention(container, cps.slice(cursor, start).join(''), myName, doc);
    const token = cps.slice(start, Math.min(end + 1, cps.length)).join('');
    if (isGif) {
      renderGifToken(container, token, url, doc, gifsEnabled !== false, gifsAsAlt);
    } else if (url && isAllowedEmojiUrl(url)) {
      const img = doc.createElement('img');
      img.className = 'emote';
      img.loading = 'lazy';
      img.alt = alt || token;
      img.src = url;
      img.onerror = () => { img.replaceWith(doc.createTextNode(token)); };
      container.append(img);
    } else if (id && EMOTE_ID_RE.test(id)) {
      const img = doc.createElement('img');
      img.className = 'emote';
      img.alt = token;
      img.src = 'https://static-cdn.jtvnw.net/emoticons/v2/' + id + '/default/dark/1.0';
      img.onerror = () => { img.replaceWith(doc.createTextNode(token)); };
      container.append(img);
    } else {
      appendWithMention(container, token, myName, doc);
    }
    cursor = Math.min(end + 1, cps.length);
  }
  if (cursor < cps.length) appendWithMention(container, cps.slice(cursor).join(''), myName, doc);
}

// Builds ONE detached row element from a message — the pure markup half of
// what used to be worker.js's addRow. Deliberately excludes everything
// insertion/liveness-related (feed, MAX_ROWS, paused, unseenCount,
// updatePill, fireEmission) — those stay in each caller, since a PWA row's
// scroll/pill/buzz behavior and an overlay row's trim/TTL behavior differ.
// Returns null for an already-superseded gigantify row (see
// docs/ARCHITECTURE.md §3a) — callers must skip insertion on null, exactly
// as the PWA's addRow did before this extraction.
//
// opts: { myName, roleClass, doc, mention }
//   myName    - lowercased self name for mention highlighting (worker.js's
//               MULTICHAT_MY_NAME), or '' to disable
//   roleClass - fn(msg) -> class name string, e.g. worker.js's own roleClass
//   doc       - the Document to build nodes against (never read implicitly)
//   mention   - false suppresses mention highlighting outright regardless of
//               myName (the overlay's case) — NOT an isOverlay branch: any
//               caller can pass mention:false for the same effect.
//   gifsEnabled - false renders msg.gifs ranges as tappable [GIF] chips
//               instead of eager <img> (bandwidth toggle); undefined/true
//               is the default-on eager render. PWA only.
//   gifsAsAlt - true forces msg.gifs ranges to render as plain bracketed
//               alt text, unconditionally (overlay's gifAlt config flag,
//               default ON) — takes precedence over gifsEnabled/url.
export function buildRow(msg, opts) {
  const { roleClass, doc } = opts;
  const myName = opts.mention === false ? '' : (opts.myName || '');

  // Gigantify double-display suppression — a row already superseded when it
  // reaches the client (ring-replay on reconnect; a live row is instead
  // hidden in place by the caller's 'mark' listener) is fully skipped, never
  // built. See docs/ARCHITECTURE.md §3a / handleGigantifyDedupe.
  if (msg.superseded) return null;

  const row = doc.createElement('div');
  if (msg.twId) row.dataset.twid = msg.twId;
  if (msg.login) row.dataset.login = msg.login;
  if (msg.ytId) row.dataset.ytid = msg.ytId;
  if (msg.authorId) row.dataset.ytauthor = msg.authorId;

  if (msg.sys) {
    // Gray info row: standard height, no badge, no gold. Exception: raids
    // get a purple banner (caller decides whether to buzz). Redemptions get
    // a distinct teal styling (reward title + redeemer visible at a glance).
    const isRaid = msg.sys === 'raid';
    const isRedeem = msg.sys === 'redeem';
    row.className = (isRaid ? 'msg raid' : isRedeem ? 'msg redeem' : 'msg info') + (msg.recovered ? ' recovered' : '');
    const text = doc.createElement('span');
    // Raid text is already self-contained ("X raiding with N viewers") —
    // prefixing msg.user would print the raider name twice.
    text.textContent = isRaid
      ? '🎉 ' + msg.text
      : isRedeem
        ? msg.user + ' redeemed ' + msg.rewardTitle + (msg.userInput ? ': ' + msg.userInput : '')
        : (msg.sys === 'announce' && msg.user ? msg.user + ': ' + msg.text : msg.text);
    row.append(text);
    return row;
  }

  row.className = 'msg' + (msg.kind ? ' paid' : '') + (msg.recovered ? ' recovered' : '') + (msg.deleted ? ' deleted' : '');
  if (msg.firstMsg) {
    const glyph = doc.createElement('span');
    glyph.className = 'firstmsg';
    glyph.textContent = '✦';
    row.append(glyph);
  }
  const badge = doc.createElement('span');
  badge.className = 'badge ' + msg.platform;
  badge.textContent = msg.platform;
  const user = doc.createElement('span');
  const rc = roleClass(msg);
  user.className = 'user' + (rc ? ' ' + rc : '');
  user.textContent = msg.user + ':';
  const text = doc.createElement('span');
  renderText(text, msg.text, msg.emotes, { myName, doc, gifs: msg.gifs, gifsEnabled: opts.gifsEnabled, gifsAsAlt: opts.gifsAsAlt });
  row.append(badge, user);
  if (msg.amount) {
    const amount = doc.createElement('span');
    amount.className = 'amount';
    amount.textContent = msg.amount;
    row.append(amount);
  }
  row.append(text);
  // Gigantify gold row extra: large animated render of the gigantified
  // emote alongside the existing label. Fail closed — missing/invalid
  // emote leaves the label-only row exactly as it was before this feature.
  if (msg.emote && msg.emote.id && EMOTE_ID_RE.test(msg.emote.id)) {
    const big = doc.createElement('img');
    big.className = 'emote gigantify';
    big.loading = 'lazy';
    big.alt = msg.emote.name || msg.emote.id;
    big.src = 'https://static-cdn.jtvnw.net/emoticons/v2/' + msg.emote.id + '/default/dark/3.0';
    big.onerror = () => { big.remove(); };
    row.append(big);
  }
  return row;
}
