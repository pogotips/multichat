// Captures raw JSON for unrecognized youtube-chat renderer types (see the
// patch in patches/) so new YT money formats — Jewels and whatever comes
// after — get harvested as real fixtures instead of silently vanishing.
import fs from 'node:fs';
import path from 'node:path';

export const CAPTURE_DIR = '/app/capture';
export const CAPTURE_FILE = 'unknown-renderers.jsonl';
export const CAPTURE_MAX_BYTES = 5 * 1024 * 1024;
// Reuses the same dir/cap as CAPTURE_FILE — log-only reaction-burst data,
// same exhaust-not-archive treatment (see multichat/CLAUDE.md).
export const REACTIONS_CAPTURE_FILE = 'reactions.jsonl';

export function bumpCount(counts, type) {
  counts[type] = (counts[type] || 0) + 1;
  return counts;
}

// Bounded top-N view of a counts object for log lines: at most `max` entries,
// sorted by count desc, ties by name asc. Pure; never mutates `counts`.
export function summarizeUnknownRenderers(counts, max = 10) {
  const entries = Object.entries(counts || {}).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(entries.slice(0, max));
}

// Reaction-burst entity -> capture-line transform (raw shape: see the
// frameworkUpdates patch in patches/youtube-chat+2.2.0.patch). Buckets are
// per-duration-window fountain summaries; YouTube omits reactionsData
// entirely on an all-zero bucket, so emoji defaults to {} rather than being
// missing from the line. Returns null when every bucket totals zero —
// callers skip writing (and counting) a no-op poll instead of flooding the
// capture file with empty lines.
export function reactionCaptureLine(raw, { ts, videoId }) {
  const buckets = (raw.reactionBuckets || []).map((b) => ({
    total: b.totalReactions || 0,
    intensity: b.intensityScore ?? null,
    emoji: Object.fromEntries((b.reactionsData || []).map((r) => [r.unicodeEmojiId, r.reactionCount])),
  }));
  if (buckets.every((b) => b.total === 0)) return null;
  return { ts, videoId, updateTimeUsec: raw.updateTimeUsec, buckets };
}

// Same raw entity, collapsed into the one summary object the Worker ingest
// lane accepts (a poll can carry several duration-window buckets; the
// ingest/topbar/overlay side only cares about one snapshot per poll).
// intensity takes the max across nonzero buckets — a short high-intensity
// bucket alongside a long quiet one should still read as a burst. Returns
// null when every bucket totals zero, same skip condition as
// reactionCaptureLine, so the two never disagree on "was this poll a no-op".
export function aggregateReactionBuckets(raw) {
  let total = 0;
  let intensity = 0;
  const emoji = {};
  for (const b of raw.reactionBuckets || []) {
    const bTotal = b.totalReactions || 0;
    if (bTotal === 0) continue;
    total += bTotal;
    if (typeof b.intensityScore === 'number' && b.intensityScore > intensity) intensity = b.intensityScore;
    for (const r of b.reactionsData || []) {
      emoji[r.unicodeEmojiId] = (emoji[r.unicodeEmojiId] || 0) + r.reactionCount;
    }
  }
  if (total === 0) return null;
  return { total, intensity, emoji };
}

// Dedupe decision for the reaction-burst ingest POST: post when the update
// window has rolled (usec changed) OR the aggregate total grew within the
// same window (a same-usec, larger-total poll must still post — YouTube can
// re-send the same window with a bigger running total before it rolls).
export function shouldPostReaction(usec, total, last) {
  if (!last) return true;
  return usec !== last.usec || total > last.total;
}

// Payload to actually post. New usec (or no prior state): the full agg,
// unchanged. Same usec, larger total: the PWA/overlay strip accumulates
// yt_reactions events into a rolling window client-side, so re-posting the
// full agg would double-count what the client already added for the earlier
// poll of the same window — post only the per-emoji delta (new - last),
// dropping any key that's <=0 (never post a non-positive count).
// Returns null when the resulting emoji map is empty (the emoji map didn't
// change within the window, or nonzero buckets whose reactionsData YouTube
// omitted): there's nothing for clients to add, and the Worker's
// sanitizeYtReactions would reject `{emoji: {}}` with a 400 anyway — the
// caller skips the POST entirely instead of generating recurring 400 noise.
export function reactionPostPayload(agg, usec, last) {
  if (!last || usec !== last.usec) {
    if (Object.keys(agg.emoji).length === 0) return null;
    return { emoji: agg.emoji, intensity: agg.intensity };
  }
  const emoji = {};
  for (const [k, v] of Object.entries(agg.emoji)) {
    const delta = v - (last.emoji[k] || 0);
    if (delta > 0) emoji[k] = delta;
  }
  if (Object.keys(emoji).length === 0) return null;
  return { emoji, intensity: agg.intensity };
}

// Appends one raw JSON line. Rotates the file to `.1` (overwriting any prior
// rotation) once appending the next line would push it past maxBytes, so
// this stays bounded indefinitely rather than growing forever — a single
// generation of history is enough for fixture harvesting.
export function appendCapture(filePath, raw, maxBytes = CAPTURE_MAX_BYTES) {
  const line = JSON.stringify(raw) + '\n';
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    // file doesn't exist yet — starts at 0
  }
  if (size + Buffer.byteLength(line) > maxBytes) {
    try {
      fs.renameSync(filePath, filePath + '.1');
    } catch (err) {
      // reached only when the file exists and is full, so a rename failure is real: the capture file would otherwise grow past maxBytes silently
      console.error(JSON.stringify({ ev: 'capture_rotate_failed', code: err && err.code ? err.code : null }));
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line);
}
