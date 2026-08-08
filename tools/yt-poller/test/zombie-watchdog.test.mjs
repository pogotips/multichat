// YT_FEED_LOSS_FORENSICS_2026-08-05.md rec 4: the empty-200 zombie watchdog.
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
