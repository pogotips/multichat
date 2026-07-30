// YouTube Data API videos.list counts (concurrent viewers + likes) — the
// poller-side half of the live-counts feature (see CLAUDE.md/ARCHITECTURE.md
// in the parent multichat worker). Split out from poller.mjs, same shape as
// normalize.mjs/recovery.mjs, so both the video-id lifecycle and the network
// call are testable in isolation without booting the whole poller process.

export const YT_COUNTS_TIMEOUT_MS = 5_000;

// Tracks the CURRENTLY-LIVE video id only — never the last-known one. A
// videos.list call must never fire once the session that resolved this id
// has ended (stream went offline, or a fresh run() never got that far), or an
// ended stream's stats keep flowing every heartbeat forever and quota gets
// spent while nothing is actually live. onEnd/reset both clear to null;
// they're kept as distinct methods so call sites read as "the session ended"
// vs. "starting a fresh attempt" even though the effect is identical.
export function createVideoIdTracker() {
  let current = null;
  return {
    onStart(liveId) {
      current = liveId || null;
    },
    onEnd() {
      current = null;
    },
    reset() {
      current = null;
    },
    get() {
      return current;
    },
  };
}

// One 1-quota-unit call returns both concurrentViewers and likeCount.
// Returns null (never an empty object) whenever there's nothing to report —
// callers spread `...(result || {})` into a heartbeat payload, so null
// cleanly contributes zero fields instead of needing a special case.
// fetchImpl is injectable for tests; apiKey/videoId absence is a silent
// no-op (no key = feature not configured yet; no videoId = nothing live).
export async function fetchYtCounts(videoId, apiKey, { fetchImpl = fetch, timeoutMs = YT_COUNTS_TIMEOUT_MS } = {}) {
  if (!apiKey || !videoId) return null;
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,statistics&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    const item = body && Array.isArray(body.items) ? body.items[0] : null;
    if (!item) return null;
    const viewers = Number(item.liveStreamingDetails && item.liveStreamingDetails.concurrentViewers);
    const likes = Number(item.statistics && item.statistics.likeCount);
    const out = {};
    if (Number.isFinite(viewers)) out.viewers = viewers;
    if (Number.isFinite(likes)) out.likes = likes;
    return Object.keys(out).length ? out : null;
  } catch (err) {
    // quota/network/timeout/malformed — skip silently, never blocks the heartbeat
    console.error(`yt counts fetch failed: ${err.message}`);
    return null;
  }
}
