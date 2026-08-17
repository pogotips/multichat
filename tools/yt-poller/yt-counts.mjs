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

// videos.list URL builder — shared by requestVideosList only. part= must
// keep liveStreamingDetails: the zombie-watchdog liveness gate (poller.mjs)
// reads actualStartTime/actualEndTime from exactly this field, and if it
// were ever dropped every response would silently read as "not live"
// forever with nothing in the logs saying so. Guarded independently in
// test/yt-counts.test.mjs ("part must request liveStreamingDetails").
function videosListUrl(videoId, apiKey) {
  return `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,statistics&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
}

// Single videos.list call (1 quota unit), used by both fetchYtCounts (below,
// unchanged public contract) and fetchYtVideoState (the liveness-aware entry
// point poller.mjs actually calls each heartbeat cycle). Never call both
// fetchYtCounts and fetchYtVideoState for the same cycle — that would spend
// two quota units for one call's worth of data; both already come back in
// the same liveStreamingDetails/statistics response.
//
// Returns:
//   { ok: true,  status, item }   — 200, item is the parsed items[0] or null if items was empty
//   { ok: false, status, item: null } — non-2xx HTTP response (status carries 404 vs other)
//   { ok: null,  status: null, item: null } — network error, timeout, or malformed JSON
async function requestVideosList(videoId, apiKey, { fetchImpl, timeoutMs }) {
  try {
    const res = await fetchImpl(videosListUrl(videoId, apiKey), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status, item: null };
    const body = await res.json();
    const item = body && Array.isArray(body.items) ? body.items[0] || null : null;
    return { ok: true, status: res.status, item };
  } catch (err) {
    // quota/network/timeout/malformed — skip silently, never blocks the heartbeat
    console.error(`yt counts fetch failed: ${err.message}`);
    return { ok: null, status: null, item: null };
  }
}

// Pure: concurrentViewers + likeCount from an already-parsed videos.list
// item. Returns null (never an empty object) whenever there's nothing to
// report — callers spread `...(result || {})` into a heartbeat payload, so
// null cleanly contributes zero fields instead of needing a special case.
function countsFromItem(item) {
  const viewers = Number(item && item.liveStreamingDetails && item.liveStreamingDetails.concurrentViewers);
  const likes = Number(item && item.statistics && item.statistics.likeCount);
  const out = {};
  if (Number.isFinite(viewers)) out.viewers = viewers;
  if (Number.isFinite(likes)) out.likes = likes;
  return Object.keys(out).length ? out : null;
}

// Pure: four-way liveness classification from an already-parsed videos.list
// item whose `liveStreamingDetails` is known to be present (caller handles
// the "item missing entirely" and "liveStreamingDetails missing" unknown
// cases before calling this — see fetchYtVideoState). Fail-open by
// construction: only a `liveStreamingDetails` object that itself states
// actualEndTime, or omits actualStartTime, is a *positive* not-live signal.
// Absent concurrentViewers is never consulted — YouTube omits it on live
// broadcasts too (round-3 audit, burst 5), so it is not evidence either way.
function livenessFromPresentDetails(lsd) {
  if (lsd.actualEndTime) return 'not_live';
  if (!lsd.actualStartTime) return 'not_live';
  return 'live';
}

// UNCHANGED public contract — every existing caller/test keeps working
// byte-for-byte. Returns null (never an empty object) whenever apiKey or
// videoId is absent (silent no-op: no key = feature not configured, no
// videoId = nothing live), the HTTP call fails outright, or the response
// carries no usable numeric field. fetchImpl is injectable for tests.
export async function fetchYtCounts(videoId, apiKey, { fetchImpl = fetch, timeoutMs = YT_COUNTS_TIMEOUT_MS } = {}) {
  if (!apiKey || !videoId) return null;
  const { ok, item } = await requestVideosList(videoId, apiKey, { fetchImpl, timeoutMs });
  if (!ok || !item) return null;
  return countsFromItem(item);
}

// Richer, single-fetch entry point — this is what poller.mjs calls each
// heartbeat cycle instead of fetchYtCounts, so the zombie-watchdog liveness
// gate and the topbar counts share one videos.list call rather than two.
// `counts` is byte-identical to what fetchYtCounts would return for the same
// response (see the ADD5 constraint in the plan doc — the topbar path must
// not move). `liveness.state` is one of 'live' | 'not_live' | 'unknown',
// always populated (never a bare null the caller has to special-case), and
// fails open: every ambiguous, absent, or failed shape reads 'unknown', not
// 'not_live' — never a truthiness check on
// `item.liveStreamingDetails?.actualStartTime`, which would collapse
// "liveStreamingDetails present but actualStartTime absent" (a genuine
// not-live signal) into the same bucket as "liveStreamingDetails missing
// entirely" (no signal at all). `liveness.at` is the ms-epoch this sample
// was produced, for the caller's own freshness check.
export async function fetchYtVideoState(videoId, apiKey, { fetchImpl = fetch, timeoutMs = YT_COUNTS_TIMEOUT_MS } = {}) {
  const at = Date.now();
  if (!apiKey || !videoId) return { counts: null, liveness: { state: 'unknown', at } };
  const { ok, status, item } = await requestVideosList(videoId, apiKey, { fetchImpl, timeoutMs });
  if (ok === null) return { counts: null, liveness: { state: 'unknown', at } }; // network/timeout/malformed
  if (!ok) {
    // HTTP 404 on a videoId we hold is the API's own positive statement the
    // resource is gone. Any other non-2xx (403 quota, 500, ...) says nothing
    // about the video itself and is also the shape transient API weirdness
    // produces — stays unknown, armed.
    return { counts: null, liveness: { state: status === 404 ? 'not_live' : 'unknown', at } };
  }
  if (!item) return { counts: null, liveness: { state: 'unknown', at } }; // HTTP 200, items empty
  const lsd = item.liveStreamingDetails;
  const liveness = { state: lsd ? livenessFromPresentDetails(lsd) : 'unknown', at };
  return { counts: countsFromItem(item), liveness };
}
