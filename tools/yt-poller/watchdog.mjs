// Round-3 audit (YT "stall" burst re-audit) empty-200 zombie watchdog:
// threshold-selection + zeroStreak decision logic, extracted out of
// poller.mjs so it's importable in a test process. Kept separate from
// poller.mjs (which isn't import-safe in a test process — top-level
// process.exit on missing env, run() side effect at module scope — see
// zombie-watchdog.test.mjs's no-export rationale) so this piece is
// unit-testable in isolation, same split as normalize.mjs/recovery.mjs/
// yt-counts.mjs/rediscovery.mjs.
//
// liveChatSessionActive only means "a chat session attached" — YouTube
// grants that for waiting rooms that never go live. Liveness (from
// fetchYtVideoState in yt-counts.mjs) SELECTS which threshold zeroStreak is
// compared against; it never suppresses the watchdog outright. Suppressing
// on `not_live` was the first-pass design and was rejected: the watchdog and
// MAX_CONSECUTIVE_ERRORS (poller.mjs) are the *only* two paths back to a
// fresh fetchLivePage() call, and a rescheduled-but-undeleted waiting room
// produces no errors — suppression would leave the poller polling a dead
// continuation with no way out, losing chat for an entire subsequent stream.

export const HEARTBEAT_INTERVAL_MS = 15_000;

// The live/unknown backstop, i.e. "a real stuck continuation on a broadcast
// that might actually have chat to lose". `unknown` deliberately takes this
// same patient threshold, never the rediscovery one, so an ambiguous
// liveness read can only ever make the watchdog *more* patient (fail open).
export const ZOMBIE_WATCHDOG_MIN = 15;
export const ZOMBIE_WATCHDOG_CYCLES = (ZOMBIE_WATCHDOG_MIN * 60_000) / HEARTBEAT_INTERVAL_MS;

// The not_live path: liveness has positively confirmed there's no broadcast
// to lose chat from. REFINEMENT 3: this is a CHECK cadence, not a teardown
// cadence — every REDISCOVERY_MIN, a throwaway probe (rediscovery.mjs)
// re-resolves the channel's current live videoId and compares it to the one
// the current run() is holding; the real session is only ever torn down if
// that id genuinely changed.
export const REDISCOVERY_MIN = 2;
export const REDISCOVERY_CYCLES = (REDISCOVERY_MIN * 60_000) / HEARTBEAT_INTERVAL_MS;

// Minimum spacing the probe gate (rediscovery.mjs createRediscoveryGate)
// enforces between probes. One heartbeat tick under the cadence on purpose:
// with the gate equal to the cadence, any fire landing a hair early (tick
// jitter) read as too_soon and the effective cadence fell back to ~4 min. This
// still holds a floor against a zeroStreak bookkeeping bug (double fire inside
// the gate window) — it is only one tick looser than the cadence.
export const REDISCOVERY_GATE_MS = (REDISCOVERY_CYCLES - 1) * HEARTBEAT_INTERVAL_MS;

// Legacy single threshold, used only when the liveness gate is off (FIX 3)
// — byte-for-byte the pre-round-3-audit behavior, so flipping the kill
// switch is a true rollback, not a different design at a different number.
export const LEGACY_ZOMBIE_WATCHDOG_MIN = 3;
export const LEGACY_ZOMBIE_WATCHDOG_CYCLES = (LEGACY_ZOMBIE_WATCHDOG_MIN * 60_000) / HEARTBEAT_INTERVAL_MS;

// A liveness sample older than this reads as 'unknown' rather than being
// trusted — since 'unknown' always takes the patient ZOMBIE_WATCHDOG path
// (never a suppression), a frozen or cached sample can only ever make the
// watchdog MORE patient, never hold it off indefinitely.
export const LIVENESS_MAX_AGE_MS = 4 * HEARTBEAT_INTERVAL_MS;

// FIX 2: a stale sample is never trusted as a positive not_live read — it
// can only make the watchdog MORE patient (route to 'unknown'), never hold
// it off. The kill switch reports its own 'gate_off' value distinct from
// 'unknown', so heartbeat consumers can tell "off on purpose" from
// "couldn't classify this cycle".
export function resolveLiveness({ gateEnabled, sampleState, sampleAt, now }) {
  if (!gateEnabled) return 'gate_off';
  const fresh = now - sampleAt <= LIVENESS_MAX_AGE_MS;
  return fresh ? sampleState : 'unknown';
}

// BLOCKING (round-3 audit): liveness SELECTS a threshold, it never
// suppresses. not_live gets the cheap rediscovery cadence; live/unknown/
// gate_off all get the patient backstop (gate_off uses the pre-audit legacy
// constant so the kill switch is a true rollback).
export function selectWatchdogThreshold({ gateEnabled, liveness }) {
  if (!gateEnabled) return { min: LEGACY_ZOMBIE_WATCHDOG_MIN, cycles: LEGACY_ZOMBIE_WATCHDOG_CYCLES };
  if (liveness === 'not_live') return { min: REDISCOVERY_MIN, cycles: REDISCOVERY_CYCLES };
  return { min: ZOMBIE_WATCHDOG_MIN, cycles: ZOMBIE_WATCHDOG_CYCLES };
}

// Pure zeroStreak decision step for the heartbeat interval's empty-200
// watchdog. Returns the next zeroStreak value plus whether/what fired —
// callers own the actual side effect (runRediscoveryProbe() vs
// currentLiveChat.stop()), this only decides WHICH cadence applies and
// WHICH path (probe-triggering vs the zombie backstop) gets taken.
export function watchdogTick({ liveChatSessionActive, zeroStreak, cycleFetched, liveness, gateEnabled }) {
  if (!liveChatSessionActive) return { zeroStreak: 0, fired: false, event: null };
  if (cycleFetched !== 0) return { zeroStreak: 0, fired: false, event: null };
  const nextZeroStreak = zeroStreak + 1;
  const { cycles } = selectWatchdogThreshold({ gateEnabled, liveness });
  if (nextZeroStreak >= cycles) {
    const event = gateEnabled && liveness === 'not_live' ? 'yt_rediscovery' : 'zombie_watchdog_reconnect';
    return { zeroStreak: 0, fired: true, event };
  }
  return { zeroStreak: nextZeroStreak, fired: false, event: null };
}

// The single secret mask for every poller log/post path: every exact value in
// `secrets` (raw and percent-encoded, since an upstream fetch error echoes the
// request URL where the key is encodeURIComponent'd) plus any `key=...` query
// value. Pure, never throws.
export function maskSecrets(text, secrets = []) {
  let masked = typeof text === 'string' ? text : String(text);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    masked = masked.split(secret).join('[redacted]');
    const enc = encodeURIComponent(secret);
    if (enc !== secret) masked = masked.split(enc).join('[redacted]');
  }
  return masked.replace(/([?&]?key=)[^&\s"']+/gi, '$1[redacted]');
}

// Masked one-line text for any thrown value: "Name: message" (plus the cause
// chain, depth-capped) or String(err). Never throws, so it is safe inside a
// catch block that must not itself fail.
export function describeErr(err, secrets = [], max = Infinity) {
  let raw;
  try {
    raw = err && err.message ? `${err.name || 'Error'}: ${err.message}` : String(err);
    let cause = err && err.cause;
    for (let depth = 0; cause && depth < 3; depth++) {
      raw += ` (cause: ${cause.message ? cause.message : String(cause)})`;
      cause = cause.cause;
    }
  } catch {
    raw = '[unstringifiable error]';
  }
  const masked = maskSecrets(raw, secrets);
  return masked.length > max ? masked.slice(0, max) : masked;
}

// Runs one interval tick without ever rejecting: a throw (sync or from any
// awaited call) becomes one structured poller_heartbeat_tick_error log line
// carrying the reason, and the caller's interval keeps firing. Log-only by
// design: no POST, no state change. The reason is truncated and masked via
// describeErr, since an upstream fetch error can echo its request URL. The log
// call is itself guarded so a failing logger cannot resurrect the rejection.
export async function guardTick(fn, log = console.log, secrets = []) {
  try {
    await fn();
  } catch (err) {
    try {
      log(JSON.stringify({ ev: 'poller_heartbeat_tick_error', reason: describeErr(err, secrets, 200) }));
    } catch {}
  }
}

// Hard ceiling on how long the in-flight guard may stay held. Every await in a
// tick is bounded (sendOnce 10s + YT_COUNTS_TIMEOUT_MS 5s, serial = ~15s), so
// a tick held past this is hung (an unbounded body read, a lost promise).
// 4 intervals sits above those timeouts and below the shortest watchdog
// threshold (REDISCOVERY_MIN, 2 min), so releasing never outruns the watchdog.
// The release fires on the first interval at or after the ceiling, so worst
// case is ceiling + one interval (75s), still under 2 min.
export const TICK_CEILING_MS = 4 * HEARTBEAT_INTERVAL_MS;

// In-flight guard around guardTick: a tick that starts while the previous one
// is still running (a slow videos.list or ingest POST outlasting the 15s
// interval) skips with one log line instead of stacking a second concurrent
// run on the same module-level cycle counters. Each tick owns a token; the
// guard is cleared in a finally only if that tick still owns it, so a throwing
// tick never wedges the runner and a stale tick can never clear a newer one's
// guard.
// Held past ceilingMs: the guard is released with one poller_tick_ceiling_release
// line (heldMs, reason; no secrets), `onCeiling` (the watchdog) runs guarded,
// and a new tick starts. The abandoned tick is "stale": its fn receives a ctx
// whose isStale() (silent) / dropIfStale(what) return true (logging poller_tick_stale_dropped once
// per tick) so it drops its heartbeat post and state writes.
export function makeGuardedTick(fn, log = console.log, secrets = [], { onCeiling, ceilingMs = TICK_CEILING_MS, now = Date.now } = {}) {
  let current = null;
  return async function guardedTick() {
    if (current) {
      const heldMs = now() - current.startedAt;
      if (heldMs < ceilingMs) {
        try { log(JSON.stringify({ ev: 'poller_heartbeat_tick_skipped', reason: 'in_flight' })); } catch {}
        return;
      }
      current.stale = true;
      current = null;
      try { log(JSON.stringify({ ev: 'poller_tick_ceiling_release', heldMs, reason: 'held_past_ceiling', ceilingMs })); } catch {}
      if (onCeiling) await guardTick(onCeiling, log, secrets);
    }
    const token = { startedAt: now(), stale: false, dropLogged: false };
    current = token;
    const ctx = {
      isStale: () => token.stale,
      dropIfStale(what) {
        if (!token.stale) return false;
        if (!token.dropLogged) {
          token.dropLogged = true;
          try { log(JSON.stringify({ ev: 'poller_tick_stale_dropped', what })); } catch {}
        }
        return true;
      },
    };
    try {
      await guardTick(() => fn(ctx), log, secrets);
    } finally {
      if (current === token) current = null;
    }
  };
}
