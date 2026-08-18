// Diffs two arrays of raw youtube-chat ChatItems (anon-poll vs authed-poll)
// captured to jsonl. Pure/no I/O so it's directly unit-testable — the
// caller is responsible for reading the jsonl files and JSON.parse-ing each
// line before calling diffMessages.
//
// Matching strategy:
//  1. Primary: match by `item.id` — YouTube assigns each live-chat message a
//     stable id server-side that's identical for every viewer/session
//     watching the same live chat, so an id present on both sides is always
//     the same real message.
//  2. Fallback: items missing an id (shouldn't happen per youtube-chat's own
//     ChatItem type, but handled defensively) are matched by content —
//     same author (channelId, falling back to name) + identical rendered
//     text + timestamps within `toleranceMs` (default 2000ms) of each
//     other. This is best-effort: it can't distinguish two genuinely
//     identical messages from the same author sent within the tolerance
//     window, but that's an acceptable false-merge for a diagnostic tool
//     since youtube-chat items always carry an id in practice.
//
// A message id that appears only on the authed side (never anon) is exactly
// the signal this tool exists to surface — e.g. member-only chat the anon
// session can't see at all.

function itemId(item) {
  return typeof item?.id === 'string' && item.id.length > 0 ? item.id : null;
}

function itemAuthorKey(item) {
  return item?.author?.channelId || item?.author?.name || null;
}

function itemText(item) {
  return (item?.message || []).map((part) => ('text' in part ? part.text : part.emojiText ?? '')).join('');
}

function itemTimestampMs(item) {
  const t = item?.timestamp;
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

export function diffMessages(anonItems, authedItems, { toleranceMs = 2000 } = {}) {
  const anonById = new Map();
  const anonNoId = [];
  for (const item of anonItems ?? []) {
    const id = itemId(item);
    if (id) anonById.set(id, item);
    else anonNoId.push(item);
  }

  const authedById = new Map();
  const authedNoId = [];
  for (const item of authedItems ?? []) {
    const id = itemId(item);
    if (id) authedById.set(id, item);
    else authedNoId.push(item);
  }

  let matchedCount = 0;
  const anonOnly = [];
  const authedOnly = [];

  for (const [id, item] of anonById) {
    if (authedById.has(id)) {
      matchedCount++;
      authedById.delete(id);
    } else {
      anonOnly.push(item);
    }
  }
  for (const item of authedById.values()) authedOnly.push(item);

  // Fallback content+timestamp matching among items with no id on either side.
  const authedNoIdRemaining = [...authedNoId];
  for (const a of anonNoId) {
    const key = itemAuthorKey(a);
    const text = itemText(a);
    const ts = itemTimestampMs(a);
    const idx = authedNoIdRemaining.findIndex((b) => {
      if (itemAuthorKey(b) !== key) return false;
      if (itemText(b) !== text) return false;
      const bTs = itemTimestampMs(b);
      if (ts == null || bTs == null) return true; // no timestamp on one side — content match alone is enough
      return Math.abs(ts - bTs) <= toleranceMs;
    });
    if (idx >= 0) {
      matchedCount++;
      authedNoIdRemaining.splice(idx, 1);
    } else {
      anonOnly.push(a);
    }
  }
  authedOnly.push(...authedNoIdRemaining);

  return {
    anonCount: (anonItems ?? []).length,
    authedCount: (authedItems ?? []).length,
    matchedCount,
    anonOnly,
    authedOnly,
  };
}

// Small formatter for the diff report — kept here (not in the main script)
// so it's covered by the same unit tests as diffMessages.
export function formatDiffSummary(diff) {
  const lines = [
    `anon messages:   ${diff.anonCount}`,
    `authed messages: ${diff.authedCount}`,
    `matched:         ${diff.matchedCount}`,
    `anon-only:       ${diff.anonOnly.length}`,
    `authed-only:     ${diff.authedOnly.length}`,
  ];
  return lines.join('\n');
}
