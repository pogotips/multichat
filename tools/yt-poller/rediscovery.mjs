// Round-3 audit REFINEMENT 3: check-then-act for the zombie watchdog's
// not_live path. The old design self-reset via a full teardown on every
// fire ('end' -> a fresh run() -> zeroStreak restart); check-then-act
// removes that teardown in the common case (held videoId unchanged), so
// this module supplies its own cadence gate rather than relying on the
// caller's zeroStreak bookkeeping to keep probes correctly spaced. Kept
// separate from poller.mjs (which isn't import-safe in a test process — see
// zombie-watchdog.test.mjs's no-export rationale) so both pieces are
// unit-testable in isolation, same split as normalize.mjs/recovery.mjs/
// yt-counts.mjs.

export const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

// Resolves the channel's CURRENTLY live videoId without touching the real
// chat session or its continuation. `LiveChatCtor` is injectable for tests
// (any EventEmitter-like class shaped like `youtube-chat`'s LiveChat);
// production callers pass the real one. Uses ONLY the package's declared
// public API — the constructor, start(), the 'start'/'error' events,
// stop() — never a deep import of its internal fetchLivePage (requests.js
// is not re-exported from the package's index.js, so calling it directly
// would be an unsupported dependency on an undeclared internal, fragile
// against a version bump with no semver signal).
//
// Costs exactly one fetchLivePage call, zero chat polling: the library's
// start() creates its polling setInterval before emitting 'start' (default
// interval 1000ms), and this resolves synchronously inside that same
// 'start'/'error' handler — well inside the window before any first poll
// tick could fire.
//
// Resolves to { videoId, reason, cleanupError }. `videoId` is the liveId
// string on success, or null on: nothing currently live (an 'error' event —
// "Live Stream was not found" is the normal shape here), a timeout, or a
// start() rejection (defensive — the current library's start() always
// resolves and never rejects, catching internally, but this must never
// surface as an unhandled rejection in the caller's tick even if that
// changes). null is never a positive signal — callers must treat it the
// same as "no answer, no change". Every null path names why (2026-10-12):
// `reason` is one of 'error_event' | 'timeout' | 'start_rejected' |
// 'empty_live_id', plus a `detail` string (error message, capped) when the
// library gave one; on success `reason` is null. `cleanupError` is set when
// probe.stop() itself threw during teardown (swallowed, never fatal) so the
// caller can log it instead of it vanishing.
const PROBE_DETAIL_MAX = 160;
function probeDetail(err) {
  const m = err && typeof err.message === 'string' ? err.message : (typeof err === 'string' ? err : '');
  return m ? m.slice(0, PROBE_DETAIL_MAX) : null;
}
export function probeCurrentLive(LiveChatCtor, channelId, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const probe = new LiveChatCtor({ channelId });
    let settled = false;
    const finish = (videoId, reason, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAllListeners?.();
      let cleanupError = null;
      try {
        probe.stop('liveness probe: done');
      } catch (err) {
        // already stopped, or never successfully started — cleanup must
        // never itself throw out of this resolver; the reason still rides
        // the result so the caller can log it.
        cleanupError = probeDetail(err) || 'stop_threw';
      }
      const out = { videoId, reason, cleanupError };
      if (detail) out.detail = detail;
      resolve(out);
    };
    const timer = setTimeout(() => finish(null, 'timeout', null), timeoutMs);
    probe.on('start', (liveId) => (liveId ? finish(liveId, null, null) : finish(null, 'empty_live_id', null)));
    probe.on('error', (err) => finish(null, 'error_event', probeDetail(err)));
    Promise.resolve(probe.start()).catch((err) => finish(null, 'start_rejected', probeDetail(err)));
  });
}

// Back-compat shape: just the videoId (string | null). Kept for callers and
// tests that only care about the id; poller.mjs uses probeCurrentLive so the
// null reason reaches the yt_rediscovery log.
export function probeCurrentLiveId(LiveChatCtor, channelId, opts) {
  return probeCurrentLive(LiveChatCtor, channelId, opts).then((r) => r.videoId);
}

// LOW-2 fix (Fable review): pure decision step for runRediscoveryProbe's
// check-then-act in poller.mjs. probeCurrentLiveId above can take up to 8s;
// if the real session ends and a NEW one starts during that await, a
// comparison against a pre-await videoId snapshot would be comparing
// against the WRONG session — and calling stop() on `changed` would tear
// down the fresh, healthy session instead of the stale one the probe
// actually started against. `generationAtStart`/`currentGeneration` are
// poller.mjs's sessionGeneration counter (bumped on every 'start'); a
// mismatch means the session swapped mid-probe and the whole comparison
// must be discarded, never acted on. `heldVideoId` is re-read AFTER the
// probe await (not the pre-await snapshot) so it's the freshest id
// available for whichever session is still current when generation matches.
export function resolveRediscoveryOutcome({ generationAtStart, currentGeneration, heldVideoId, probedVideoId }) {
  if (generationAtStart !== currentGeneration) {
    return { action: 'discarded' };
  }
  if (!heldVideoId) {
    return { action: 'no_session' };
  }
  // null probedVideoId (probe failed/timed out/nothing currently live) is
  // never a positive signal — treated identically to "unchanged".
  const changed = Boolean(probedVideoId) && probedVideoId !== heldVideoId;
  return { action: changed ? 'changed' : 'unchanged' };
}

// Cadence + single-flight gate. `minIntervalMs` is REDISCOVERY_MIN in ms;
// `now` is injectable for tests. tryStart() returns either
// { allowed: false, reason: 'in_flight' | 'too_soon' } or
// { allowed: true, release }. The caller MUST call release() once the probe
// settles (success or failure) — until it does, every tryStart() reads
// in_flight, guarding against a hung fetchLivePage stacking overlapping
// probes.
export function createRediscoveryGate({ minIntervalMs, now = () => Date.now() }) {
  // -Infinity, not 0: "never probed" must never collide with a real
  // timestamp. A real `now()` starting at 0 (a fake clock in a test, or —
  // impossibly, but this must hold regardless — a process that started at
  // the Unix epoch) would otherwise read the very first tryStart() as
  // "too_soon" relative to a probe that never actually happened.
  let lastProbeAt = -Infinity;
  let inFlight = false;
  return {
    tryStart() {
      if (inFlight) return { allowed: false, reason: 'in_flight' };
      const t = now();
      if (t - lastProbeAt < minIntervalMs) return { allowed: false, reason: 'too_soon' };
      inFlight = true;
      lastProbeAt = t;
      return {
        allowed: true,
        release: () => {
          inFlight = false;
        },
      };
    },
  };
}

// One yt_rediscovery log line. `liveness` is the value resolveLiveness
// returned for the tick that fired the probe (never a literal), so a line
// can't claim a reading the watchdog didn't actually have.
export function formatRediscoveryLog(liveness, fields) {
  return JSON.stringify({ ev: 'yt_rediscovery', liveness, ...fields });
}
