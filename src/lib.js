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

// Spoken-name cleanup for TTS only — see TTS_NAME_CLEANUP_DRYRUN_2026-08-05.md
// for the approved regex and the deferred Step2 (separator-segment strip,
// e.g. darc-ttv -> darc) this deliberately does NOT implement yet. Strips a
// trailing digit run, absorbing one immediately-preceding `_`/`-` in the same
// match so `cool_guy_99` -> `cool_guy` rather than leaving a dangling
// separator. Guards against over-stripping an identity down to nothing or
// near-nothing (an all-digit name, or a 1-char remainder) by returning the
// original name unchanged in that case.
export function cleanSpokenName(name) {
  const cleaned = name.replace(/[_-]?\d+$/, '');
  return cleaned.length < 2 ? name : cleaned;
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
