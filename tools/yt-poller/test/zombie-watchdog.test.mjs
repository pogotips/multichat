// Internal forensics doc (2026-08-05), rec 4: the empty-200 zombie watchdog.
// parser.js can return an empty actions array on a valid 200 with no 'chat'/
// 'error' event, so consecutiveErrors (poller.mjs) never trips and a stuck
// continuation can poll forever with fetched=0. This exercises the
// zeroStreak decision block poller.mjs's heartbeat interval runs every 15s.
//
// The block itself isn't exported (module-level state + top-level run()
// side effects on import — same no-export rationale as drainLoop, see
// ingest-tail-h2.test.mjs). Reimplemented inline here, quoted from the
// source for traceability (poller.mjs, inside the 15s setInterval):
//
//   if (liveChatSessionActive) {
//     if (cycleFetched === 0) {
//       zeroStreak++;
//       if (zeroStreak >= ZOMBIE_WATCHDOG_CYCLES) {
//         zeroStreak = 0;
//         currentLiveChat?.stop('zombie watchdog: sustained fetched=0');
//       }
//     } else {
//       zeroStreak = 0;
//     }
//   } else {
//     zeroStreak = 0;
//   }
import { describe, it, expect } from 'vitest';

const ZOMBIE_WATCHDOG_MIN = 3;
const ZOMBIE_WATCHDOG_CYCLES = (ZOMBIE_WATCHDOG_MIN * 60_000) / 15_000; // 12, real poller.mjs constant

function zombieWatchdogTick(state, cycleFetched, onFire) {
  if (state.liveChatSessionActive) {
    if (cycleFetched === 0) {
      state.zeroStreak++;
      if (state.zeroStreak >= ZOMBIE_WATCHDOG_CYCLES) {
        state.zeroStreak = 0;
        onFire();
      }
    } else {
      state.zeroStreak = 0;
    }
  } else {
    state.zeroStreak = 0;
  }
}

describe('zombie watchdog: trigger case', () => {
  it('fires exactly once, exactly at ZOMBIE_WATCHDOG_CYCLES consecutive zero-fetch cycles while a session is active', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    let fireCount = 0;
    for (let i = 1; i <= ZOMBIE_WATCHDOG_CYCLES; i++) {
      expect(fireCount).toBe(0); // must not fire early
      zombieWatchdogTick(state, 0, () => fireCount++);
    }
    expect(fireCount).toBe(1);
    expect(state.zeroStreak).toBe(0); // reset immediately on fire
  });
});

describe('zombie watchdog: no-false-fire (quiet-but-live)', () => {
  it('never fires when zero/low minutes alternate — no unbroken zero streak reaches the threshold', () => {
    // Mirrors the real 2026-08-05 00:30-00:42 shape: isolated zero-message
    // minutes (00:34, 00:36, 00:41) interspersed with 1-3 msg/min minutes,
    // never three *consecutive* zero minutes. 4 cycles/min (15s cadence).
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    let fireCount = 0;
    const minutes = 15; // longer than ZOMBIE_WATCHDOG_MIN, spanning well past the quiet stretch
    for (let m = 0; m < minutes; m++) {
      const isZeroMinute = m % 2 === 0; // alternating, so max consecutive zero cycles is 4, well under 12
      for (let cycle = 0; cycle < 4; cycle++) {
        const fetched = isZeroMinute ? 0 : (cycle === 0 ? 2 : 0);
        zombieWatchdogTick(state, fetched, () => fireCount++);
      }
    }
    expect(fireCount).toBe(0);
  });
});

describe('zombie watchdog: no-false-fire (idle/no session)', () => {
  it('never advances zeroStreak or fires while liveChatSessionActive is false, no matter how long', () => {
    // The heartbeat interval itself is deliberately NOT live-gated (runs
    // 24/7) — cycleFetched===0 is the normal, permanent state with no
    // stream up. This is the steady state most of the day; it must never
    // trip the watchdog.
    const state = { liveChatSessionActive: false, zeroStreak: 0 };
    let fireCount = 0;
    for (let i = 0; i < ZOMBIE_WATCHDOG_CYCLES * 20; i++) {
      zombieWatchdogTick(state, 0, () => fireCount++);
      expect(state.zeroStreak).toBe(0);
    }
    expect(fireCount).toBe(0);
  });
});

// --- round-3 audit: liveness selects the threshold, it never suppresses ---
// (see the plan doc's BLOCKING section — suppressing the watchdog on
// not_live was the first-pass design and was rejected: it's one of only two
// paths back to a fresh fetchLivePage() call, and a rescheduled-but-
// undeleted waiting room produces no errors, so suppression would strand the
// poller on a dead continuation with no way out.)
//
// Reimplemented inline, quoted from poller.mjs's setInterval body (same
// no-export rationale as above). Note REFINEMENT 3: reaching the not_live
// threshold no longer fires 'yt_rediscovery' directly — it calls
// runRediscoveryProbe(), which is itself gated/tested separately in
// rediscovery.test.mjs (spacing, single-flight, conditional teardown). What
// this file tests is strictly the threshold-selection layer: WHICH cadence
// applies and WHICH path (probe-triggering vs the zombie backstop) gets
// taken, not the probe's own internals.
//
//   const watchdogThresholdCycles = !WATCHDOG_LIVENESS_GATE
//     ? LEGACY_ZOMBIE_WATCHDOG_CYCLES
//     : liveness === 'not_live' ? REDISCOVERY_CYCLES : ZOMBIE_WATCHDOG_CYCLES;
//   if (liveChatSessionActive) {
//     if (cycleFetched === 0) {
//       zeroStreak++;
//       if (zeroStreak >= watchdogThresholdCycles) {
//         zeroStreak = 0;
//         if (WATCHDOG_LIVENESS_GATE && liveness === 'not_live') {
//           onTriggered('yt_rediscovery'); // runRediscoveryProbe() in the real code
//         } else {
//           onTriggered('zombie_watchdog_reconnect');
//         }
//       }
//     } else {
//       zeroStreak = 0;
//     }
//   } else {
//     zeroStreak = 0;
//   }

const HEARTBEAT_INTERVAL_MS = 15_000;
const NEW_ZOMBIE_WATCHDOG_MIN = 15; // live/unknown/gate_off-legacy-exempt backstop
const NEW_ZOMBIE_WATCHDOG_CYCLES = (NEW_ZOMBIE_WATCHDOG_MIN * 60_000) / HEARTBEAT_INTERVAL_MS; // 60
const REDISCOVERY_MIN = 5; // not_live path — REFINEMENT 3: a check cadence, not a teardown cadence
const REDISCOVERY_CYCLES = (REDISCOVERY_MIN * 60_000) / HEARTBEAT_INTERVAL_MS; // 20
const LEGACY_ZOMBIE_WATCHDOG_MIN = 3; // WATCHDOG_LIVENESS_GATE=off (FIX 3)
const LEGACY_ZOMBIE_WATCHDOG_CYCLES = (LEGACY_ZOMBIE_WATCHDOG_MIN * 60_000) / HEARTBEAT_INTERVAL_MS; // 12

function watchdogTick(state, cycleFetched, liveness, gateOn, onTriggered) {
  const watchdogThresholdCycles = !gateOn
    ? LEGACY_ZOMBIE_WATCHDOG_CYCLES
    : liveness === 'not_live'
      ? REDISCOVERY_CYCLES
      : NEW_ZOMBIE_WATCHDOG_CYCLES;
  if (state.liveChatSessionActive) {
    if (cycleFetched === 0) {
      state.zeroStreak++;
      if (state.zeroStreak >= watchdogThresholdCycles) {
        state.zeroStreak = 0;
        onTriggered(gateOn && liveness === 'not_live' ? 'yt_rediscovery' : 'zombie_watchdog_reconnect');
      }
    } else {
      state.zeroStreak = 0;
    }
  } else {
    state.zeroStreak = 0;
  }
}

describe('round-3 audit: threshold selection by liveness (never suppression)', () => {
  it('live + silent past 15 min ⇒ triggers the zombie_watchdog_reconnect path, not before', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    const triggered = [];
    for (let i = 1; i <= NEW_ZOMBIE_WATCHDOG_CYCLES; i++) {
      expect(triggered.length).toBe(0);
      watchdogTick(state, 0, 'live', true, (ev) => triggered.push(ev));
    }
    expect(triggered).toEqual(['zombie_watchdog_reconnect']);
  });

  it('not_live + silent past REDISCOVERY_MIN (5 min) ⇒ triggers the yt_rediscovery path — this is a probe trigger, not an unconditional teardown or a suppression', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    const triggered = [];
    for (let i = 1; i <= REDISCOVERY_CYCLES; i++) {
      expect(triggered.length).toBe(0);
      watchdogTick(state, 0, 'not_live', true, (ev) => triggered.push(ev));
    }
    expect(triggered).toEqual(['yt_rediscovery']);
  });

  it('not_live never reaches the 15-min threshold — it triggers at REDISCOVERY_MIN, proving a different cadence rather than a disabled gate', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    let triggerCount = 0;
    for (let i = 1; i <= REDISCOVERY_CYCLES; i++) watchdogTick(state, 0, 'not_live', true, () => triggerCount++);
    expect(triggerCount).toBe(1);
    expect(NEW_ZOMBIE_WATCHDOG_CYCLES).toBeGreaterThan(REDISCOVERY_CYCLES); // sanity: cadences are genuinely different
  });

  it('liveness unknown takes the patient 15-min threshold — never fires early, never permanently disarmed (fail-open regression guard)', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    const fires = [];
    for (let i = 1; i < NEW_ZOMBIE_WATCHDOG_CYCLES; i++) {
      watchdogTick(state, 0, 'unknown', true, (ev) => fires.push(ev));
    }
    expect(fires).toEqual([]); // not yet at 60
    watchdogTick(state, 0, 'unknown', true, (ev) => fires.push(ev));
    expect(fires).toEqual(['zombie_watchdog_reconnect']); // fires at 60, same as 'live'
  });

  it('WATCHDOG_LIVENESS_GATE=off ⇒ single 3-min legacy threshold regardless of liveness (FIX 3 kill switch)', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    const fires = [];
    for (let i = 1; i <= LEGACY_ZOMBIE_WATCHDOG_CYCLES; i++) {
      expect(fires.length).toBe(0);
      watchdogTick(state, 0, 'not_live', false, (ev) => fires.push(ev)); // liveness says not_live, gate is off
    }
    // Byte-identical to pre-audit behavior: always zombie_watchdog_reconnect,
    // always at the legacy cadence, liveness value ignored entirely.
    expect(fires).toEqual(['zombie_watchdog_reconnect']);
  });

  it('synthetic stuck continuation: live, fetched pinned 0 past 15 min ⇒ still fires with the gate in place (proves "correctly gated" ≠ "quietly disarmed")', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    let fireCount = 0;
    for (let cycle = 1; cycle <= NEW_ZOMBIE_WATCHDOG_CYCLES * 3; cycle++) {
      watchdogTick(state, 0, 'live', true, () => fireCount++);
    }
    // Fires once per full threshold period, never zero: 3 full periods ⇒ 3 fires.
    expect(fireCount).toBe(3);
  });

  it('BLOCKING (b) regression: a stale never-started waiting room (repeated not_live, zero errors) still gets probed within REDISCOVERY_MIN, never strands the poller with no rediscovery path at all', () => {
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    let triggerCount = 0;
    // Simulate the burst-5 shape: liveness reads not_live every cycle,
    // nothing ever errors (MAX_CONSECUTIVE_ERRORS never trips per the
    // BLOCKING analysis), fetched stays 0 the whole time. This layer only
    // asserts the rediscovery PATH is reached on schedule — whether the
    // probe then actually tears the session down is rediscovery.test.mjs's
    // job (it won't, here: check-then-act only tears down on a changed
    // videoId, which this scenario by definition never has).
    for (let cycle = 1; cycle <= REDISCOVERY_CYCLES; cycle++) {
      watchdogTick(state, 0, 'not_live', true, () => triggerCount++);
    }
    expect(triggerCount).toBe(1); // rediscovery path reached — the poller is never stuck with no way to notice a real change
  });
});

// --- Change 2 / FIX 2: freshness bound ---
// Reimplemented inline, quoted from poller.mjs's setInterval body:
//
//   const livenessFresh = Date.now() - lastLiveness.at <= LIVENESS_MAX_AGE_MS;
//   const liveness = !WATCHDOG_LIVENESS_GATE ? 'gate_off' : livenessFresh ? lastLiveness.state : 'unknown';

const LIVENESS_MAX_AGE_MS = 4 * HEARTBEAT_INTERVAL_MS; // 60_000

function resolveLiveness(sampleState, sampleAt, now, gateOn) {
  if (!gateOn) return 'gate_off';
  const fresh = now - sampleAt <= LIVENESS_MAX_AGE_MS;
  return fresh ? sampleState : 'unknown';
}

describe('round-3 audit: liveness freshness bound', () => {
  it('a fresh not_live sample is trusted as-is', () => {
    expect(resolveLiveness('not_live', 1_000_000, 1_000_000 + LIVENESS_MAX_AGE_MS, true)).toBe('not_live');
  });

  it('a stale sample reads unknown regardless of what it says — never trusted as a positive not_live signal', () => {
    const now = 1_000_000 + LIVENESS_MAX_AGE_MS + 1; // 1ms past the boundary
    expect(resolveLiveness('not_live', 1_000_000, now, true)).toBe('unknown');
    expect(resolveLiveness('live', 1_000_000, now, true)).toBe('unknown');
  });

  it('a stale sample can only make the watchdog MORE patient, never hold it off (feeds into the 15-min path via unknown)', () => {
    const now = 1_000_000 + LIVENESS_MAX_AGE_MS + 1;
    const liveness = resolveLiveness('not_live', 1_000_000, now, true); // sample said not_live, but it's stale
    const state = { liveChatSessionActive: true, zeroStreak: 0 };
    const fires = [];
    for (let i = 1; i < REDISCOVERY_CYCLES; i++) watchdogTick(state, 0, liveness, true, (ev) => fires.push(ev));
    expect(fires).toEqual([]); // did NOT fire at the rediscovery cadence the stale sample would have implied
  });
});
