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

// Spoken-name cleanup for TTS only (rule of 2026-10-12; supersedes the
// 2026-08-05 trailing-digit-only Step1, the deferred Step2 separator-segment
// strip e.g. darc-ttv -> darc is still NOT implemented). Rules, in order:
//  1. Leading @s are stripped (a raw "@Jon_123" in msg.user must not be read
//     as "at Jon underscore..."); a bare "@" falls back to the raw name.
//  2. If the name has at least 3 letters BEFORE its first digit, cut at that
//     first digit and drop a dangling _ - . or whitespace run:
//     RRR0O08B8 -> RRR, wiccedrasta9981 -> wiccedrasta, cool_guy_99 -> cool_guy.
//  3. Otherwise only a trailing digit run (plus one preceding _/-) is
//     stripped, as before: "2pac" and "l33thax0r" keep their digits.
//  4. Junk guard, ONLY for names that contained a digit: fewer than 3 letters
//     in the result, or more digits than letters, is not pronounceable as a
//     name -> "someone" (x9z8, 12345, A1, Jo_5). A name with no digit at all
//     is returned as-is (Ed, Al, a bare "@x" -> "x"), never replaced.
// Non-Latin names (\p{L}) with no digits pass through untouched. Flat:
// interpolated into the PWA and the overlay (no nested named functions).
export function cleanSpokenName(name) {
  const raw = String(name || '');
  const deAt = raw.replace(/^@+/, '');
  const base = deAt.length > 0 ? deAt : raw;
  const idx = base.search(/\p{Nd}/u);
  if (idx === -1) return base;
  const lead = (base.slice(0, idx).match(/\p{L}/gu) || []).length;
  const cleaned = lead >= 3
    ? base.slice(0, idx).replace(/[_\-.\s]+$/u, '')
    : base.replace(/[_-]?\p{Nd}+$/u, '');
  const letters = (cleaned.match(/\p{L}/gu) || []).length;
  const digits = (cleaned.match(/\p{Nd}/gu) || []).length;
  if (letters < 3 || digits > letters) return 'someone';
  return cleaned;
}

// "@RRR0O08B8 lol" is spoken "RRR lol": a word that starts with @ at a word
// boundary (start of text or after whitespace) is replaced by its spoken
// name (spokenNameFor, the same path a sender name takes). The whole
// whitespace-delimited token after the @ is the handle, "-" and "." included
// ("@Some_Name-x9k," -> handle "Some_Name-x9k"); trailing punctuation is
// peeled first and put back after cleanup. A token with nothing but
// punctuation after the @ is left as typed. Emails (a@b.com), mid-word @ and
// plain words are untouched. Flat: interpolated into the PWA and the overlay.
export function cleanSpokenMentions(text, extra) {
  return String(text || '').replace(/(^|\s)@(\S+)/gu, (m, pre, token) => {
    const tail = token.match(/[^\p{L}\p{N}]+$/u);
    const trail = tail ? tail[0] : '';
    const handle = trail ? token.slice(0, token.length - trail.length) : token;
    if (!handle) return m;
    return pre + spokenNameFor(handle, extra) + trail;
  });
}

// Spoken word map (MULTICHAT_TTS_SAY_AS secret, parsed by parseSayAsMap):
// case-insensitive WHOLE-WORD replacement, speech only. A word is a run of
// letters/digits/underscore, so "-" "." "!" and spaces are boundaries and key
// "A" never matches inside "AB" or "ABC". One regex pass, longest key first,
// so a mapped form is never re-scanned for further keys. Empty or missing
// map returns the text untouched. Flat (no named closures): interpolated
// into the PWA and the overlay.
export function applySpokenWordMap(text, map) {
  const src = String(text == null ? '' : text);
  if (!map || typeof map !== 'object') return src;
  const spoken = Object.create(null);
  const keys = [];
  for (const k of Object.keys(map)) {
    if (typeof map[k] !== 'string' || !k) continue;
    const lower = k.toLowerCase();
    if (!(lower in spoken)) keys.push(lower);
    spoken[lower] = map[k];
  }
  if (keys.length === 0) return src;
  keys.sort((a, b) => b.length - a.length);
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')).join('|');
  const re = new RegExp('(^|[^\\p{L}\\p{N}_])(' + alt + ')(?![\\p{L}\\p{N}_])', 'giu');
  return src.replace(re, (m, pre, hit) => pre + spoken[hit.toLowerCase()]);
}

// ── Spoken-text curse filter ───────────────────────────────────────────
// Whole-word body list (keys are lowercase letters only, after the leet map
// below). Includes slurs on purpose: this is what must never be read aloud.
export const SPOKEN_CURSE_WORDS = [
  'fuck','fucker','fuckers','fucking','fucked','motherfucker','motherfucking',
  'shit','shitty','shits','bullshit','horseshit','cunt','cunts','bitch','bitches',
  'asshole','assholes','ass','arse','arsehole','dick','dickhead','cock','cocksucker',
  'pussy','twat','wanker','bastard','goddamn','piss','pissed','whore','slut',
  'nigger','niggers','nigga','niggas','faggot','faggots','fag','fags',
  'retard','retarded','retards','kike','spic','chink','wetback','tranny','dyke',
  'cum','jizz','tits','titties','dildo','rape','rapist',
];
// Unambiguous strong subset: matched at the START or END of a username
// SEGMENT (names split on non-alphanumerics and camelCase humps, so
// "ShitLord" and "bigshit" hit but "YoshiTheDino"/"Michishita" do not), and as
// a PREFIX of body words only when the rest is a real inflection ("fucking",
// "shitty", "bitches"; not "niggling"). Deliberately excludes anything that
// appears inside ordinary words/names (ass, cock, dick, cunt -> Scunthorpe,
// rapist -> therapist).
export const SPOKEN_CURSE_STRONG = ['fuck','shit','nigg','fagg','bitch','whore','retard','kike','tranny'];

// Lowercase, undo common leet substitutions, keep letters plus a '*'
// wildcard ('@' and '*' both stand for one unknown letter: f@ck, f*ck).
// Flat: interpolated into the PWA and the overlay.
export function spokenCurseKey(word) {
  return String(word || '').toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's')
    .replace(/@/g, '*')
    .replace(/[^\p{L}*]/gu, '');
}

// extra: optional array of additional whole-word keys (server var).
export function isSpokenCurse(word, extra) {
  if (!/\p{L}/u.test(String(word || ''))) return false; // digit-only tokens ("455") are numbers, not leet
  const k = spokenCurseKey(word);
  if (!/\p{L}/u.test(k)) return false;
  const list = Array.isArray(extra) ? SPOKEN_CURSE_WORDS.concat(extra) : SPOKEN_CURSE_WORDS;
  if (k.includes('*')) {
    const re = new RegExp('^' + k.replace(/\*/g, '.') + '$', 'u');
    return list.some((w) => re.test(w));
  }
  return list.includes(k) || SPOKEN_CURSE_STRONG.some((w) => k.startsWith(w)
    && /^(s|es|er|ers|ed|ing|in|y|ty|ier|iest|head|heads|face|faces|hole|holes|wit|wad|bag|bags|storm|show|ass|ard|ards|ery|ish)$/.test(k.slice(w.length)));
}

export function bleepSpokenText(text, extra) {
  return String(text || '').replace(/\S+/gu, (tok) => (isSpokenCurse(tok, extra) ? 'bleep' : tok));
}

// Usernames: per-segment match. Segments split on non-alphanumeric runs and
// lower->upper camel humps; each is leet-mapped, and a hit is a segment equal
// to, starting with or ending with a strong word (or an extra of 3+ letters).
export function isCurseName(name, extra) {
  const segs = String(name || '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').split(/[^\p{L}\p{N}]+/u)
    .map((seg) => spokenCurseKey(seg).replace(/\*/g, ''));
  return segs.some((k) => SPOKEN_CURSE_STRONG.some((w) => k === w || k.startsWith(w) || k.endsWith(w))
    || (Array.isArray(extra) && extra.some((w) => w.length >= 3 && (k === w || k.startsWith(w) || k.endsWith(w)))));
}

export function spokenNameFor(name, extra) {
  return isCurseName(name, extra) ? 'someone' : cleanSpokenName(name);
}

// The one spoken form of a sender name on every surface (PWA chat/gold/
// readout lines, overlay lines): curse check + cleanSpokenName, then the
// spoken word map. @mention tokens in a body reach the same
// spokenNameFor through cleanSpokenMentions, and the word map runs over the
// finished body, so "@X" and sender X are spoken identically. Flat.
export function spokenSenderName(name, extra, sayAs) {
  return applySpokenWordMap(spokenNameFor(name, extra), sayAs);
}

// Server-side only (not interpolated): MULTICHAT_TTS_SAY_AS secret -> map.
// JSON object of word -> spoken form. Unset/empty -> empty map, no problem.
// Bad JSON / non-object -> empty map plus a `bad` reason code ('not_json' |
// 'not_object'); the value itself is never returned in a log-able field.
// Entries are capped (200 entries, 64 chars per key and per spoken form,
// control chars stripped) and non-string values skipped. Null-prototype
// result so a "__proto__" key is just a key.
export function parseSayAsMap(raw) {
  const map = Object.create(null);
  if (raw == null || String(raw).trim() === '') return { map, bad: null };
  let parsed;
  try { parsed = JSON.parse(String(raw)); } catch { return { map, bad: 'not_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { map, bad: 'not_object' };
  let n = 0;
  for (const k of Object.keys(parsed)) {
    if (n >= 200) break;
    const key = k.replace(/[\x00-\x1F\x7F]/g, '').trim();
    const v = parsed[k];
    if (!key || key.length > 64 || typeof v !== 'string') continue;
    const spoken = v.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 64);
    if (!spoken) continue;
    map[key] = spoken;
    n++;
  }
  return { map, bad: null };
}

// Server-side only (not interpolated): MULTICHAT_TTS_EXTRA_CURSES -> keys.
export function parseExtraCurses(raw) {
  const out = [];
  String(raw || '').split(',').forEach((part) => {
    const k = spokenCurseKey(part).replace(/\*/g, '');
    if (k.length >= 3 && /\p{L}/u.test(k) && !out.includes(k)) out.push(k);
  });
  return out;
}

// Spoken-output-only mention normalization: strips the '@' off an in-text
// mention ("hey @Jon thanks" -> "hey Jon thanks") so it reads as the name,
// not "at Jon". Deliberately narrow -- only an @ immediately preceded by
// start-of-string or whitespace counts as a mention marker, so an email
// address embedded in text ("a@b.com") is never touched: its '@' is
// preceded by a non-whitespace character ('a'), so the pattern doesn't
// match there at all. Only the '@' itself is consumed (\S matches exactly
// one character) -- the rest of the mentioned name is untouched literal
// text, never re-parsed. Called by sanitizeSpokenBody (below) and by the
// overlay's own utteranceFor (worker.js overlayHtml).
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

// Blank every Twitch emote / GIF range (code-point offsets, end inclusive --
// same convention as renderText) so only the typed words remain. Malformed
// entries are skipped, never thrown on. Flat: interpolated into the PWA.
export function stripEmoteRanges(text, emotes, gifs) {
  const cps = Array.from(typeof text === 'string' ? text : '');
  const ranges = [].concat(Array.isArray(emotes) ? emotes : [], Array.isArray(gifs) ? gifs : []);
  for (const r of ranges) {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) continue;
    if (r.start < 0 || r.start > r.end || r.end >= cps.length) continue;
    for (let i = r.start; i <= r.end; i++) cps[i] = ' ';
  }
  return cps.join('').replace(/\s+/g, ' ').trim();
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
export function sanitizeSpokenBody(text, maxLen = 120, extra, sayAs) {
  if (!text) return '';
  let out = stripControlChars(text);
  out = stripUrls(out);
  out = collapseRepeatedChars(out);
  out = cleanSpokenMentions(out, extra);
  out = applySpokenWordMap(out, sayAs);
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

// Client-side companion to the server's sse_replay_result log (src/worker.js
// handleEvents) — decides whether a Last-Event-ID replay left a gap the
// ring could no longer cover. ringFloor is the oldest surviving ring
// message id, or null when the ring is empty (nothing was ever dropped, so
// no gap is possible). Equal is anchored, not a gap: lastEventId === ringFloor
// means the client's last-seen row is still the oldest one in the ring, so
// every message after it was replayed intact.
export function detectReplayGap(lastEventId, ringFloor) {
  if (lastEventId == null) return false;
  return ringFloor === null || lastEventId < ringFloor;
}

// ── PWA reload replay: the persisted feed cursor ───────────────────────────
// PWA only (interpolated at the PWA embed site alone — the OBS overlay must
// keep getting zero ring rows on a scene-switch reload). The page persists
// {hi, ts} — the highest msg.id it has actually rendered and the local clock
// when that last advanced — under FEED_CURSOR_KEY. A fresh page load whose
// cursor is younger than FEED_CURSOR_MAX_AGE_MS asks the DO for the WHOLE
// ring (lastEventId = RING_REPLAY_EVENT_ID: the edge forwards any finite
// numeric string, and handleEvents replays every ring entry with
// id > 0) and runs the replay-gap decision against the stored hi, so
// "hi below ringFloor → gray row, at/above → silent" keeps its meaning. The
// DO replays only `id > lastId`, so sending the stored hi itself could never
// bring back the rows that were on screen before the reload. Older or
// missing cursor → the connect is exactly a fresh install's.
// Both helpers are flat (no nested named closures — esbuild keepNames would
// inject __name wrappers the page never defines; see renderGifToken).
export const FEED_CURSOR_KEY = 'multichat-feed';
export const FEED_CURSOR_MAX_AGE_MS = 30 * 60_000;
export const FEED_CURSOR_WRITE_MIN_MS = 5_000;
export const RING_REPLAY_EVENT_ID = 0;

// raw localStorage string → the stored hi, or null when there is nothing a
// reload should trust: missing/corrupt, no positive finite hi, no numeric
// ts, or |now - ts| at/over maxAgeMs (a future-dated ts is as untrusted as a
// stale one — a clock jump must not resurrect an ancient cursor).
export function readFeedCursor(raw, now, maxAgeMs) {
  if (typeof raw !== 'string' || raw === '') return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  if (typeof v.hi !== 'number' || !Number.isFinite(v.hi) || v.hi <= 0) return null;
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return null;
  if (Math.abs(now - v.ts) >= maxAgeMs) return null;
  return v.hi;
}

// Throttled high-water tracker. note(id, now) returns the JSON to write when
// a write is due (first note always; then at most once per minWriteMs),
// else null while marking the cursor dirty; flush(now) returns the JSON for
// a dirty cursor (pagehide / hidden / trailing timer) or null. ts is always
// the time hi last ADVANCED, never the flush time, so the 30-min expiry
// measures from the last rendered message. Lower/equal/non-numeric ids are
// ignored: a replayed or duplicate row can never rewind the cursor.
export function createFeedCursor(minWriteMs) {
  let hi = 0;
  let ts = 0;
  let lastWrite = -Infinity;
  let dirty = false;
  return {
    note(id, now) {
      if (typeof id !== 'number' || !(id > hi)) return null;
      hi = id;
      ts = now;
      dirty = true;
      if (now - lastWrite < minWriteMs) return null;
      lastWrite = now;
      dirty = false;
      return JSON.stringify({ hi, ts });
    },
    flush(now) {
      if (!dirty) return null;
      lastWrite = now;
      dirty = false;
      return JSON.stringify({ hi, ts });
    },
  };
}

// Stable per-account key for the PWA name-tap sheet: platform + Twitch login
// or YouTube authorId. Display name is never a key (names collide across and
// within platforms; see pushMessage's own "never match by display name" rule).
// sys rows (raid/redeem/info...) are not keyed. No stable id => null => not tappable.
export function userKeyOf(msg) {
  if (!msg || msg.sys) return null;
  if (msg.platform === 'tw') return typeof msg.login === 'string' && msg.login ? 'tw:' + msg.login : null;
  if (msg.platform === 'yt') return typeof msg.authorId === 'string' && msg.authorId ? 'yt:' + msg.authorId : null;
  return null;
}

// Bounded in-memory list of message objects for the PWA name-tap sheet.
// Fed only by frames that passed the seen-id gate; never rendered in the
// feed; gone on reload. applyMark mirrors the PWA 'mark' SSE handler's
// matching rules and mutates the stored objects in place so a later sheet
// render shows the struck/removed state.
export function createMessageStore(cap) {
  const items = [];
  return {
    push(msg) {
      items.push(msg);
      while (items.length > cap) items.shift();
    },
    applyMark(m) {
      if (!m) return;
      for (const it of items) {
        if (m.action === 'delete') {
          if (m.targetId && (m.platform === 'yt' ? it.ytId === m.targetId : it.twId === m.targetId)) it.deleted = true;
        } else if (m.action === 'author_delete') {
          if (m.authorId && it.authorId === m.authorId) it.deleted = true;
        } else if (m.action === 'supersede') {
          if (m.targetId && it.twId === m.targetId) it.superseded = true;
        } else if (m.login && it.login === m.login) {
          it.deleted = true;
        }
      }
    },
    forKey(key) {
      const out = [];
      for (let i = items.length - 1; i >= 0; i--) {
        if (userKeyOf(items[i]) === key) out.push(items[i]);
      }
      return out;
    },
    size() { return items.length; },
  };
}

// ── Name-tap sheet: stats line + copy buttons ───────────────────────────────
// All helpers are interpolated into the PWA page via Function.prototype
// .toString(): keep them flat (no nested named closures -- esbuild keepNames
// would inject __name wrappers the page does not define).

// Single numeric run -> number, else null (zero or 2+ runs is ambiguous).
export function parseAmountNumber(str) {
  if (typeof str !== 'string') return null;
  const runs = str.match(/\d[\d.,]*/g);
  if (!runs || runs.length !== 1) return null;
  const run = runs[0];
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(run)) return Number(run.replace(/,/g, ''));
  if (/^\d+,\d{1,2}$/.test(run)) return Number(run.replace(',', '.'));
  if (/^\d+(\.\d+)?$/.test(run)) return Number(run);
  return null;
}

// Split "CA$12.50" / "5,00 €" into currency prefix/suffix around the number.
export function splitAmountCurrency(str) {
  if (typeof str !== 'string') return { prefix: '', suffix: '', num: null, decimals: 0 };
  const m = str.match(/\d[\d.,]*/);
  if (!m) return { prefix: '', suffix: '', num: null, decimals: 0 };
  const run = m[0];
  const prefix = str.slice(0, m.index).trim();
  const suffix = str.slice(m.index + run.length).trim();
  const dm = run.match(/[.,](\d+)$/);
  const isDecimal = dm && !(/^\d{1,3}(,\d{3})+$/.test(run));
  return { prefix, suffix, num: parseAmountNumber(str), decimals: isDecimal ? dm[1].length : 0 };
}

// Per-kind gold totals for the sheet's stats line. Deterministic order;
// currencies are never summed across groups or converted.
export function summarizeGold(msgs) {
  const out = [];
  const list = Array.isArray(msgs) ? msgs.filter((m) => m && m.kind && m.kind !== 'member_gift_received') : [];
  const order = ['cheer', 'power_up', 'sub', 'giftsub', 'superchat', 'supersticker', 'member_new', 'member_milestone', 'member_gift', 'member_renewed', 'yt_gift'];
  for (const kind of order) {
    const rows = list.filter((m) => m.kind === kind);
    if (!rows.length) continue;
    const n = rows.length;
    const label = TTS_LABELS[kind] || kind;
    if (kind === 'cheer' || kind === 'power_up') {
      const bits = rows.reduce((a, m) => a + (parseAmountNumber(m.amount) || 0), 0);
      out.push(n + '× ' + label + ' (' + bits + ' bits)');
    } else if (kind === 'giftsub' || kind === 'member_gift') {
      const gifts = rows.reduce((a, m) => {
        const v = parseAmountNumber(m.amount);
        return a + (v === null ? 1 : v);
      }, 0);
      out.push(n + '× ' + label + ' (' + gifts + ' gifts)');
    } else if (kind === 'superchat' || kind === 'supersticker') {
      const groups = new Map();
      for (const m of rows) {
        const raw = typeof m.amount === 'string' ? m.amount : '';
        const p = splitAmountCurrency(raw);
        const gk = p.prefix + '|' + p.suffix;
        let g = groups.get(gk);
        if (!g) { g = { prefix: p.prefix, suffix: p.suffix, n: 0, sum: 0, dec: 0, ok: true, raws: [] }; groups.set(gk, g); }
        g.n++;
        g.raws.push(raw);
        if (p.num === null) g.ok = false; else { g.sum += p.num; if (p.decimals > g.dec) g.dec = p.decimals; }
      }
      for (const g of groups.values()) {
        out.push(g.n + '× ' + label + ' (' + (g.ok ? g.prefix + g.sum.toFixed(g.dec) + g.suffix : g.raws.join(' + ')) + ')');
      }
    } else if (kind === 'yt_gift') {
      const names = [];
      for (const m of rows) {
        const nm = typeof m.amount === 'string' ? m.amount.trim() : '';
        if (nm && !names.includes(nm)) names.push(nm);
      }
      const shown = names.slice(0, 3);
      if (names.length > 3) shown.push('…');
      out.push(n + '× ' + label + (shown.length ? ' (' + shown.join(', ') + ')' : ''));
    } else {
      out.push(n + '× ' + label);
    }
  }
  return out;
}

// Pure stats for the sheet (the page formats the time -- locale dependent).
export function sheetStats(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  let firstTs = null;
  for (const m of list) {
    if (m && Number.isFinite(m.ts) && (firstTs === null || m.ts < firstTs)) firstTs = m.ts;
  }
  return { count: list.length, firstTs, gold: summarizeGold(list) };
}

// Chat handle for the @ copy button. '' when unknown.
export function copyHandle(platform, login, user) {
  if (platform === 'tw') return String(login || '').toLowerCase().replace(/^@+/, '');
  if (platform === 'yt') return String(user || '').replace(/^@+/, '').trim();
  return '';
}

// Clipboard write with execCommand fallback. Never throws.
export async function writeClipboard(text, nav, doc) {
  try {
    await nav.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    if (ta.remove) ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

// ── Phone TTS modes (Gold <-> All; gold alerts always speak) ────────────────────────────────────
// Pure helpers interpolated into the PWA; keep flat (no nested named closures).
export const TTS_MODES = ['gold', 'all'];
export const TTS_MODE_KEY = 'multichat-tts-mode';
// Array (not Set) so jsonForScript can inject it unchanged; helpers use .includes.
// Lowercase; matched against the Twitch login and the YT display name. Any name
// ending in "bot" is also skipped (isTtsBotName). TTS only -- rows still display.
export const TTS_BOT_NAMES = [
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'sery_bot', 'phantombot',
  'botisimo', 'deepbot', 'coebot', 'soundalerts', 'kofistreambot', 'pokemoncommunitygame',
];
export const TTS_CHAT_MAX_AGE_MS = 20_000;
export const TTS_QUEUE_CAP = 5;
export const CLIENT_ERROR_SEND_MAX = 5; // session-scoped cap on /client-error beacons per page — a looping error must never spam the endpoint/log
export const TTS_CHAT_TEXT_MAX = 200;
export const TTS_MODE_ICONS = { gold: '🔊', all: '📣' };
// Mute toggle (left of the speaker button): silences ALL phone speech without touching
// the Gold/All mode. Own key -- never TTS_MODE_KEY. Glyphs must differ from TTS_MODE_ICONS.
export const TTS_MUTE_KEY = 'multichat-tts-muted';
export const TTS_MUTE_ICONS = { live: '🔔', muted: '🔕' };

export function nextTtsMode(mode) {
  return mode === 'gold' ? 'all' : 'gold';
}

// True for a listed bot account or any name ending in "bot" (case-insensitive;
// "Bottle" is fine, "Robot" is not). The name is normalized first: leading
// @s stripped (YouTube handles arrive as "@Streamlabs"), verified-tick glyphs
// (U+2713, U+2714, U+2705) removed, trimmed, lowercased. Interpolated into
// the PWA (keep flat).
export function isTtsBotName(name) {
  const n = String(name || '').trim().replace(/^@+/, '').replace(/[\u2713\u2714\u2705]/g, '').trim().toLowerCase();
  return TTS_BOT_NAMES.includes(n) || n.endsWith('bot');
}

// Why a plain chat message must NOT be read aloud in All mode; null = speak.
export function chatSpeakSkipReason(msg, opts) {
  const o = opts || {};
  const now = o.now;
  const myName = typeof o.myName === 'string' ? o.myName : '';
  if (msg.sys) return 'sys';
  if (msg.kind) return 'gold';
  if (msg.readAloud) return 'readout';
  if (msg.replay || msg.recovered) return 'replay';
  if (msg.deleted || msg.superseded) return 'deleted';
  if (!Number.isFinite(msg.ts) || now - msg.ts > o.maxAgeMs) return 'stale';
  const login = String(msg.login || '').toLowerCase();
  const user = String(msg.user || '').toLowerCase();
  if (myName && (msg.login === myName || user === myName)) return 'self';
  if (isTtsBotName(login) || isTtsBotName(user)) return 'bot';
  if (typeof msg.text !== 'string') return 'emote_only';
  if (msg.text.trimStart().startsWith('!')) return 'command';
  if (/\b(?:https?:\/\/|www\.)\S+/i.test(msg.text)) return 'link';
  if (stripEmoteRanges(msg.text, msg.emotes, msg.gifs) === '') return 'emote_only';
  return null;
}

export function formatChatUtterance(msg, extra, sayAs) {
  const body = applySpokenWordMap(bleepSpokenText(cleanSpokenMentions(stripUrls(stripControlChars(stripEmoteRanges(msg.text, msg.emotes, msg.gifs))), extra), extra), sayAs).slice(0, TTS_CHAT_TEXT_MAX).trim();
  return spokenSenderName(msg.user || msg.login || '', extra, sayAs) + ', ' + body;
}

// Read-Out-Loud redeem line: same body as formatChatUtterance, but an empty
// body (emote-only, URL-only) yields '' so nothing is spoken. Flat: PWA.
export function readoutUtterance(msg, extra, sayAs) {
  const body = applySpokenWordMap(bleepSpokenText(cleanSpokenMentions(stripUrls(stripControlChars(stripEmoteRanges(msg.text, msg.emotes, msg.gifs))), extra), extra), sayAs).slice(0, TTS_CHAT_TEXT_MAX).trim();
  return body ? spokenSenderName(msg.user || msg.login || '', extra, sayAs) + ', ' + body : '';
}

// Overlay plain-chat line (tts=all): "<name> says <body>". Same name path and
// same @mention/word-map treatment as the PWA lines above, so overlay speech
// matches PWA speech; no bleep here (the overlay never had one). '' when
// there is no body. Flat: interpolated into the overlay.
export function formatOverlayChatUtterance(msg, extra, sayAs) {
  const body = applySpokenWordMap(cleanSpokenMentions(msg.text || '', extra), sayAs);
  return body ? spokenSenderName(msg.user, extra, sayAs) + ' says ' + body : '';
}

// Gold items jump ahead of pending chat (but stay behind earlier gold); over
// cap, the oldest chat item is dropped first. Returns a NEW array.
export function enqueueSpeechItem(queue, item, cap) {
  const next = queue.slice();
  if (item.gold) {
    let at = next.findIndex((q) => !q.gold);
    if (at === -1) at = next.length;
    next.splice(at, 0, item);
  } else {
    next.push(item);
  }
  if (next.length > cap) {
    const drop = next.findIndex((q) => !q.gold);
    next.splice(drop === -1 ? 0 : drop, 1);
  }
  return next;
}

// '!tts off|on|all' from a live (non-replay, fresh) mod/broadcaster row.
export function parseTtsCommand(msg, opts) {
  const o = opts || {};
  if (!msg || msg.sys || msg.isMod !== true || msg.replay || msg.recovered) return null;
  if (!Number.isFinite(msg.ts) || o.now - msg.ts > o.maxAgeMs) return null;
  if (typeof msg.text !== 'string') return null;
  const m = msg.text.match(/^!tts\s+(off|on|all)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// '!tts off' returns to Gold (alerts keep speaking); 'on' and 'all' read all chat.
export function applyTtsCommand(arg) {
  return arg === 'off' ? 'gold' : 'all';
}

// ── Tap-to-translate ────────────────────────────────────────────────────────
// translateRequestText / translateLabel are interpolated into the PWA (keep
// flat); the rest are server-side only (POST /translate in worker.js).
export const TRANSLATE_TEXT_MAX = 300;
// Workers AI neuron pricing for TRANSLATE_MODEL (per million tokens).
export const NEURONS_PER_M_IN = 9091;
export const NEURONS_PER_M_OUT = 27273;

export function estimateTokens(str) {
  const s = String(str || '');
  return s.length === 0 ? 0 : Math.max(1, Math.ceil(s.length / 4));
}

// Per-model neuron rates (per million tokens), Workers AI pricing page, verified 2026-10-12.
export const NEURON_RATES = {
  '@cf/google/gemma-4-26b-a4b-it': { in: 9091, out: 27273 },
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': { in: 4119, out: 34868 },
};

export function neuronsFor(inTok, outTok, rates) {
  const i = Number.isFinite(inTok) ? inTok : 0;
  const o = Number.isFinite(outTok) ? outTok : 0;
  const r = rates || { in: NEURONS_PER_M_IN, out: NEURONS_PER_M_OUT };
  return (i * r.in + o * r.out) / 1e6;
}

export function normalizeForCompare(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function extractModelText(out) {
  let t = '';
  if (out && typeof out.response === 'string') t = out.response;
  else {
    const c = out && out.choices && out.choices[0] && out.choices[0].message ? out.choices[0].message.content : null;
    if (typeof c === 'string') t = c;
    else if (Array.isArray(c)) {
      for (let i = 0; i < c.length; i++) {
        const p = c[i];
        if (p && typeof p.text === 'string') t += p.text;
      }
    }
  }
  return t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function translateLabel(reason) {
  if (reason === 'translating') return 'translating…';
  if (reason === 'same') return 'already English';
  if (reason === 'empty') return 'nothing to translate';
  if (reason === 'minute' || reason === 'budget') return 'limit hit';
  return 'failed';
}

// True for a settled entry that must NOT stick in the PWA cache: a "failed" or
// "limit hit" label retries on the next tap. Only a real translation, "already
// English" ('same') and "nothing to translate" ('empty', no network) are final.
// Interpolated into the PWA (keep flat).
export function translateRetryable(entry) {
  return !!entry && entry.state === 'label' && entry.reason !== 'same' && entry.reason !== 'empty';
}

export function translateRequestText(text, emotes, gifs) {
  return stripUrls(stripControlChars(stripEmoteRanges(text, emotes, gifs))).trim().slice(0, TRANSLATE_TEXT_MAX);
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
  // OFF by default — unlike gifAlt (an opt-out safety default on content
  // already flowing through chat), a reaction burst is a brand-new animated
  // element on the scene with nothing behind it upstream; the scene operator
  // opts in deliberately, per scene, same posture as ttsBody above.
  reactions: { type: 'enum', values: ['on', 'off'], default: 'off' },
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

// Pure, no DOM: expands a status-payload reactions object (server shape —
// see sanitizeYtReactions/buildStatusPayload in worker.js) into per-emoji
// {glyph, n} spawn units. Object.keys order matches the order
// sanitizeYtReactions already sorted its top-N entries in (descending
// count), so a caller enforcing a per-tick spawn cap exhausts the loudest
// emoji first rather than round-robining arbitrarily.
export function reactionSpawnUnits(reactions) {
  if (!reactions || !reactions.emoji) return [];
  return Object.keys(reactions.emoji).map((glyph) => ({ glyph, n: reactions.emoji[glyph] }));
}

// One reaction-burst particle for the overlay: an emoji span animated up the
// right edge via CSS (see .reaction-particle/@keyframes reactionRise in the
// overlay's <style>). intensity (0-1) scales size and speed — a hotter
// burst reads as bigger and faster, not just "more particles" (the per-tick
// spawn-rate cap is the caller's job, not this function's). doc is always
// injected — same reasoning as every other DOM-touching helper in this file
// (see the block comment above appendWithMention): this function's body is
// re-embedded into the overlay's client-side <script> via
// Function.prototype.toString(), so a bare `document` reference would only
// fail silently on that path, never at build/test time.
export function spawnReactionParticle(container, glyph, intensity, doc) {
  const el = doc.createElement('span');
  el.className = 'reaction-particle';
  el.textContent = glyph;
  const clamped = Math.max(0, Math.min(1, intensity || 0));
  const size = 20 + clamped * 28; // 20px..48px
  const duration = 2600 - clamped * 1200; // 2.6s..1.4s, hotter = faster
  const drift = Math.round((Math.random() - 0.5) * 40); // px, horizontal wander
  el.style.fontSize = size + 'px';
  el.style.right = Math.round(8 + Math.random() * 24) + 'px';
  el.style.animationDuration = duration + 'ms';
  el.style.setProperty('--drift', drift + 'px');
  container.append(el);
  setTimeout(() => el.remove(), duration);
  return el;
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
      img.src = 'https://static-cdn.jtvnw.net/emoticons/v2/' + id + '/default/dark/2.0';
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

  row.className = 'msg' + (msg.kind ? ' paid' : '') + (msg.pointsGigantify ? ' points-gigantify' : '') + (msg.rewardGift ? ' reward-gift' : '') + (msg.recovered ? ' recovered' : '') + (msg.deleted ? ' deleted' : '') + (msg.readAloud ? ' readout' : '');
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
  if (msg.verified === true) {
    // YouTube verified channel: tick after the name, inside span.user so the
    // overlay (same buildRow) shows it too. Non-verified rows keep the single
    // text-node shape the golden fixture pins. The tick is an EMPTY element
    // drawn entirely by CSS (.verified::before, a filled round badge),
    // never a text glyph, so a check mark typed into a display name stays
    // plain name text and can't imitate it (2026-10-12). Display names are
    // never rewritten. role/aria-label keep it announced by assistive tech
    // now that there is no text; setAttribute is guarded because the unit
    // tests' fake doc has none (real DOM and the vm driver both do).
    user.textContent = msg.user;
    const tick = doc.createElement('span');
    tick.className = 'verified';
    tick.title = 'Verified channel';
    if (tick.setAttribute) {
      tick.setAttribute('role', 'img');
      tick.setAttribute('aria-label', 'Verified channel');
    }
    user.append(tick, ':');
  } else {
    user.textContent = msg.user + ':';
  }
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

// ── YT-chip forced reconnect ──────────────────────────────────────────────
// A Durable Object moved or restarted mid-stream leaves the OLD instance
// serving any already-open SSE stream: Twitch keeps flowing but the poller's
// YT posts land on the NEW instance, so the old one's YT age grows, the chip
// goes red, and frames (ping/status) keep arriving — the 60 s silence
// watchdog never fires. Only a fresh connection reaches the live instance.
export const YT_CHIP_RED_MS = 90_000; // status.yt age at/above which the YT chip is red (PWA CHIP_STALE_MS, overlay)
export const YT_FORCE_RED_MS = 60_000; // chip must have been red this long before a forced reconnect
export const YT_FORCE_FRAME_FRESH_MS = 60_000; // ...with a frame this recent (stream alive; else the silence watchdog owns it)
export const YT_FORCE_CAP_MS = 300_000; // ...and no forced reconnect more recently than this (a real poller outage: one per 5 min)

// Pure decision for the PWA watchdog poll and the overlay's 15 s timer.
// state: { ytStaleSince (ms epoch the chip turned red, null when not red),
// lastFrameAt (ms epoch of the last SSE frame), lastForcedAt (ms epoch of the
// last forced reconnect, null = never), now }. cfg: { redMs, frameMs, capMs }
// — passed in (callers interpolate the constants above) because this
// function is interpolated into the page scripts via toString() and cannot
// close over module scope.
export function shouldForceYtReconnect(state, cfg) {
  if (state.ytStaleSince == null) return false;
  if (state.now - state.ytStaleSince < cfg.redMs) return false;
  if (state.now - state.lastFrameAt > cfg.frameMs) return false;
  if (state.lastForcedAt != null && state.now - state.lastForcedAt < cfg.capMs) return false;
  return true;
}
