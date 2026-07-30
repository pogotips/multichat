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
]);

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
};

// Age cap on emission. A persisted (and possibly stale) floor must never let a
// day-old ring replay flood the buzzer/synth on load — only rows at least this
// recent can still fire. Shared by the client predicate and its test.
export const EMIT_TTL_MS = 30 * 60_000;
