// Replay of the 4 YT handoffs (old stream -> new stream) through the real
// exported watchdog / rediscovery / recovery decision functions, on a fake
// clock, to pin today's blind window and score fix candidates C1-C7 against
// it. Evidence only: nothing under src or tools/yt-poller/*.mjs changes.
// Timelines: test/fixtures/handoff-replay.json. Simulator and the list of what
// it cannot drive without a src seam: test/helpers/handoff-sim.mjs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  watchdogTick as realWatchdogTick, REDISCOVERY_MIN, REDISCOVERY_CYCLES, REDISCOVERY_GATE_MS, ZOMBIE_WATCHDOG_CYCLES,
  LEGACY_ZOMBIE_WATCHDOG_CYCLES,
} from '../watchdog.mjs';
import { createRediscoveryGate } from '../rediscovery.mjs';
import { classifyYtItem, RECOVERY_AGE_CAP_MS, RECOVERY_COUNT_CAP } from '../recovery.mjs';
import {
  TODAY, SHIPPED, CANDIDATES, replicaTick, simulate, blindSeconds, handoffTimeline, tooSoonRun, jitterSeries,
} from './helpers/handoff-sim.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/handoff-replay.json', import.meta.url), 'utf8'));
const [h1, h2, h3, h4] = fx.handoffs;
const ALL = [TODAY, ...CANDIDATES];
const byId = (id) => ALL.find((c) => c.id === id);
const r2 = (n) => (n == null ? n : +n.toFixed(2));

// Blind window for handoff 4 under candidate c: [latest go-live, earliest go-live].
const blind4 = (c, over) => {
  const r = simulate(handoffTimeline(h4, fx, over), c);
  const live = over?.bLiveSec ?? h4.bLiveSec;
  return { leave: r2(r.leaveSec), cause: r.cause, lo: blindSeconds(r.leaveSec, h4, c, live), hi: over?.bLiveSec != null ? null : blindSeconds(r.leaveSec, h4, c, h4.bLiveEarliestSec) };
};

describe('harness anchoring', () => {
  it('replicaTick(SHIPPED) matches the real watchdogTick over the whole input grid', () => {
    for (const gateEnabled of [true, false]) {
      for (const liveness of ['live', 'not_live', 'unknown', 'gate_off']) {
        for (const cycleFetched of [0, 3]) {
          for (const liveChatSessionActive of [true, false]) {
            for (let zeroStreak = 0; zeroStreak <= 70; zeroStreak++) {
              const args = { liveChatSessionActive, zeroStreak, cycleFetched, liveness, gateEnabled };
              expect(replicaTick(SHIPPED, args)).toEqual(realWatchdogTick(args));
            }
          }
        }
      }
    }
  });

  it('shipped constants are the ones the replay assumes (C1: 2 min / 8 cycles)', () => {
    expect(REDISCOVERY_MIN).toBe(2);
    expect(REDISCOVERY_CYCLES).toBe(8);
    expect(REDISCOVERY_GATE_MS).toBe(105_000); // one 15 s tick under the 120 s cadence
    expect(ZOMBIE_WATCHDOG_CYCLES).toBe(60);
    expect(LEGACY_ZOMBIE_WATCHDOG_CYCLES).toBe(12);
  });
});

describe('replay: baseline (pre-C1, REDISCOVERY_MIN 5) blind window per real handoff', () => {
  it('#4 reproduces the observed leave and new-session start, and a 239 s blind window (>=, go-live is an upper bound)', () => {
    const r = simulate(handoffTimeline(h4, fx), TODAY);
    expect(r.cause).toBe('rediscovery');
    expect(r2(r.leaveSec)).toBe(h4.leaveObservedSec);
    expect(r2(r.leaveSec + h4.endToStartSec)).toBe(h4.bStartObservedSec);
    // First zero cycle ends at 29.35 s, the 20th at 314.35 s: the 20-cycle rule fired, not the error path
    // (chat closed at 308.9 s, 8 errors would land at 316.9 s).
    expect(r.probes).toEqual([{ t: 314.35, outcome: 'changed' }]);
    expect(blind4(TODAY)).toMatchObject({ lo: 239.07, hi: 277.86 });
  });

  it('#2 and #3: same rule path, 314.55 s after the last message under the assumed phase; blind window not derivable (no go-live)', () => {
    for (const h of [h2, h3]) {
      expect(h.bLiveSec).toBeNull();
      const r = simulate(handoffTimeline(h, fx), TODAY);
      expect(r.cause).toBe('rediscovery');
      expect(r2(r.leaveSec)).toBe(314.55);
      expect(blindSeconds(r.leaveSec, h, TODAY, h.bLiveSec)).toBeNull();
    }
  });

  it('#1: error-path leave, 8 s after chat dies (re-typed MAX_CONSECUTIVE_ERRORS); blind window not derivable', () => {
    const r = simulate(handoffTimeline(h1, fx), TODAY);
    expect(r.cause).toBe('errors');
    expect(r.leaveSec).toBe(8);
    expect(blindSeconds(r.leaveSec, h1, TODAY, h1.bLiveSec)).toBeNull();
  });

  it('the 7 items YT replays to the new session at join are all posted as recovered, so the blind window cost 0 visible messages', () => {
    const { count, ageAtJoinFirstSec: oldest, ageAtJoinLastSec: newest } = h4.bPreJoinItems;
    const armedAt = Date.UTC(2026, 9, 7, 1, 5, 14);
    const seen = new Set();
    let ephemeral = { armed: true, armedAt, recoveredCount: 0 };
    const results = [];
    for (let i = 0; i < count; i++) {
      const age = oldest - ((oldest - newest) * i) / (count - 1); // interior ages are synthetic
      const res = classifyYtItem({ id: `m${i}`, timestamp: new Date(armedAt - age * 1000) }, ephemeral, seen);
      ephemeral = res.ephemeral;
      results.push(res);
    }
    expect(results.every((r) => r.send && r.recovered)).toBe(true);
  });
});

describe('C7 (recovery caps): analysis-only, boundaries of the real classifier', () => {
  const armedAt = Date.UTC(2026, 9, 7, 1, 5, 14);
  const classify = (ageSec, recoveredCount = 0) =>
    classifyYtItem({ id: `x${ageSec}-${recoveredCount}`, timestamp: new Date(armedAt - ageSec * 1000) },
      { armed: true, armedAt, recoveredCount }, new Set());
  it('an item is lost only if older than 10 min at join or past 200 recovered', () => {
    expect(RECOVERY_AGE_CAP_MS).toBe(600_000);
    expect(RECOVERY_COUNT_CAP).toBe(200);
    expect(classify(599).recovered).toBe(true);
    expect(classify(601).send).toBe(false);
    expect(classify(60, 199).recovered).toBe(true);
    expect(classify(60, 200).send).toBe(false);
  });
  // Handoff 4's oldest backlog item was 239 s old at join, 361 s under the age cap.
});

describe('candidates: blind seconds, handoff 4 (latest go-live .. earliest go-live)', () => {
  it.each([
    ['today', 314.55, 'rediscovery', 239.07, 277.86],
    ['C1', 134.55, 'rediscovery', 59.07, 97.86],
    ['C2', 314.55, 'rediscovery', 239.07, 277.86],
    ['C3', 314.55, 'rediscovery', 239.07, 277.86], // flip probe fires at 14.35 s, before go-live: no gain
    ['C4', 89.55, 'rediscovery', 14.07, 52.86],
    ['C5', 311.9, 'errors', 236.42, 275.21],
    ['C6', 314.55, 'rediscovery', 237.57, 276.36],
  ])('%s', (id, leave, cause, lo, hi) => {
    expect(blind4(byId(id))).toEqual({ leave, cause, lo, hi });
  });
});

describe('candidates: sensitivity of handoff 4', () => {
  it('late go-live (200 s): a probe that fires before go-live resets the streak, later ones still catch it', () => {
    const got = Object.fromEntries(ALL.map((c) => [c.id, blind4(c, { bLiveSec: 200 }).lo]));
    expect(got).toEqual({ today: 117.31, C1: 57.31, C2: 117.31, C3: 117.31, C4: 12.31, C5: 114.66, C6: 115.81 });
  });
  it('old stream ends after go-live (flip at 90 s): C3 now helps, C1/C4 unchanged', () => {
    const got = Object.fromEntries(ALL.map((c) => [c.id, blind4(c, { oldNotLiveFromSec: 90 }).lo]));
    expect(got).toEqual({ today: 239.07, C1: 59.07, C2: 239.07, C3: 29.07, C4: 29.07, C5: 236.42, C6: 237.57 });
  });
  it('#1/#2/#3 leave deltas vs today (blind windows not derivable): C5 -5 s on the error path, C1 -180 s and C4 -225 s on the rule path', () => {
    const leave = (h, c) => r2(simulate(handoffTimeline(h, fx), c).leaveSec);
    expect(leave(h1, byId('C5')) - leave(h1, TODAY)).toBe(-5);
    for (const h of [h2, h3]) {
      expect(r2(leave(h, byId('C1')) - leave(h, TODAY))).toBe(-180);
      expect(r2(leave(h, byId('C4')) - leave(h, TODAY))).toBe(-225);
      expect(leave(h, byId('C2'))).toBe(leave(h, TODAY));
      expect(leave(h, byId('C3'))).toBe(leave(h, TODAY));
    }
  });
});

describe('too_soon interaction (probe gate vs cadence)', () => {
  it('gate replay on the logged fire times: every logged skip is predicted, the misses are probes the log-time replay calls too_soon (probe duration is not logged)', () => {
    let match = 0; let total = 0; let skipsPredicted = 0; let skipsObserved = 0;
    for (const run of fx.rediscoveryRuns.runs) {
      let clock = 0;
      const gate = createRediscoveryGate({ minIntervalMs: 300_000, now: () => clock * 1000 });
      const times = run.intervalsSec.reduce((a, d) => [...a, a[a.length - 1] + d], [0]);
      times.forEach((t, i) => {
        clock = t;
        const g = gate.tryStart();
        const predictedSkip = !g.allowed;
        const observedSkip = run.outcomes[i] === 't';
        if (g.allowed) g.release();
        total++;
        if (predictedSkip === observedSkip) match++;
        if (observedSkip) { skipsObserved++; if (predictedSkip) skipsPredicted++; }
      });
    }
    expect(total).toBe(66);
    expect(skipsObserved).toBe(16);
    expect(skipsPredicted).toBe(16);
    expect(match).toBe(57);
  });

  // The model's skip share (~41%) overstates the logged 16/66 (24%): the logged
  // times carry unlogged probe durations. Read the candidate rows as relative.
  it('probes per hour and skip share by candidate, same jitter, 24 h', () => {
    const iv = jitterSeries(fx);
    const row = (c) => {
      const period = c.ageProbeSec != null ? 15 : c.rediscoveryMin * 60;
      const r = tooSoonRun(iv, period, c.gateMinSec, 24);
      return { perHour: +(r.probes / 24).toFixed(1), skipShare: r.skipShare };
    };
    expect(Object.fromEntries(ALL.map((c) => [c.id, row(c)]))).toEqual({
      today: { perHour: 7.1, skipShare: 0.412 },
      C1: { perHour: 17.8, skipShare: 0.409 },
      C2: { perHour: 12, skipShare: 0 },
      C3: { perHour: 7.1, skipShare: 0.412 },
      C4: { perHour: 240, skipShare: 0 },
      C5: { perHour: 7.1, skipShare: 0.412 },
      C6: { perHour: 7.1, skipShare: 0.412 },
    });
  });
});

describe('scenarios beyond the 4 handoffs', () => {
  const wait = (c) => simulate({
    tickPhaseSec: 14.35, lastMsgSec: 0, oldNotLiveFromSec: 0, oldChatClosedSec: null, probeSec: fx.probeSec,
    horizonSec: 3600, rawLivenessAt: () => 'not_live', probeAnswerAt: () => fx.heldIdOld,
  }, c);
  const end = (c) => simulate({ ...handoffTimeline(h4, fx), probeAnswerAt: () => null }, c);

  it('waiting room held for 1 h, probe returns the same id: no teardown for any candidate; probes in the hour', () => {
    const got = {};
    for (const c of ALL) {
      const r = wait(c);
      expect(r.leaveSec).toBeNull();
      expect(r.rediscoveryTeardown).toBe(false);
      got[c.id] = r.probes.length;
    }
    expect(got).toEqual({ today: 11, C1: 29, C2: 11, C3: 11, C4: 237, C5: 11, C6: 11 });
  });

  it('a single stream that ends with no follow-up (probe returns null): never a rediscovery teardown; probes before the error path closes the session', () => {
    const got = {};
    for (const c of ALL) {
      const r = end(c);
      expect(r.rediscoveryTeardown).toBe(false);
      expect(r.cause).toBe('errors');
      got[c.id] = [r2(r.leaveSec), r.probes.length];
    }
    expect(got).toEqual({
      today: [316.9, 1], C1: [316.9, 2], C2: [316.9, 1], C3: [316.9, 2], C4: [316.9, 18], C5: [311.9, 0], C6: [316.9, 1],
    });
  });

  it('mid-stream fetched=0 while liveness reads live (zombie): every candidate leaves at the 60th zero cycle via the zombie path, no probe', () => {
    for (const c of ALL) {
      const r = simulate({ ...handoffTimeline(h4, fx), oldChatClosedSec: null, rawLivenessAt: () => 'live' }, c);
      expect([r2(r.leaveSec), r.cause, r.probes.length]).toEqual([914.35, 'zombie', 0]);
    }
  });
});

describe('invariants every candidate is judged against (none BREAKS)', () => {
  const quiet = { ...handoffTimeline(h4, fx), oldChatClosedSec: null };
  it('unknown liveness fails open to the 15 min threshold, no probes', () => {
    for (const c of ALL) {
      const r = simulate({ ...quiet, rawLivenessAt: () => 'unknown' }, c);
      expect([r2(r.leaveSec), r.cause, r.probes.length]).toEqual([914.35, 'zombie', 0]);
    }
  });
  it('WATCHDOG_LIVENESS_GATE=off still takes the legacy 3 min zombie path, no probes', () => {
    for (const c of ALL) {
      const r = simulate(quiet, c, { gateEnabled: false });
      expect([r2(r.leaveSec), r.cause, r.probes.length]).toEqual([194.35, 'zombie', 0]);
    }
  });
  it('a live reading (a 200 from videos.list) never suppresses or extends the zombie backstop', () => {
    for (const c of ALL) {
      const r = simulate({ ...quiet, rawLivenessAt: () => 'live' }, c);
      expect(r2(r.leaveSec)).toBe(914.35);
    }
  });
});

// The fix under test: REDISCOVERY_MIN 5 -> 2 with the probe gate moved under the
// cadence. SHIPPED is driven by the real constants, the old 239-278 s case above
// stays pinned on BASELINE_PRE_C1.
describe('shipped C1 + gate under cadence', () => {
  it('#4: blind window drops from 239-278 s to under 100 s, via the rediscovery path', () => {
    const r = blind4(SHIPPED);
    expect(r.cause).toBe('rediscovery');
    expect(r.hi).toBeLessThan(100);
    expect(r.lo).toBeLessThan(r.hi);
    expect(blind4(TODAY).lo).toBeGreaterThan(239);
  });
  it('no probe is skipped as too_soon: on the 24 h jitter model and on #4 / a 1 h waiting room', () => {
    const r = tooSoonRun(jitterSeries(fx), REDISCOVERY_MIN * 60, SHIPPED.gateMinSec, 24);
    expect(r.skipped).toBe(0);
    for (const probes of [simulate(handoffTimeline(h4, fx), SHIPPED).probes,
      simulate({ tickPhaseSec: 14.35, lastMsgSec: 0, oldNotLiveFromSec: 0, oldChatClosedSec: null, probeSec: fx.probeSec,
        horizonSec: 3600, rawLivenessAt: () => 'not_live', probeAnswerAt: () => fx.heldIdOld }, SHIPPED).probes]) {
      expect(probes.filter((p) => p.outcome.startsWith('too_soon'))).toEqual([]);
    }
  });
  it('a waiting room whose videoId has not changed is never torn down at the new cadence', () => {
    const r = simulate({
      tickPhaseSec: 14.35, lastMsgSec: 0, oldNotLiveFromSec: 0, oldChatClosedSec: null, probeSec: fx.probeSec,
      horizonSec: 3600, rawLivenessAt: () => 'not_live', probeAnswerAt: () => fx.heldIdOld,
    }, SHIPPED);
    expect(r.leaveSec).toBeNull();
    expect(r.rediscoveryTeardown).toBe(false);
    expect(r.probes.length).toBeGreaterThan(20);
    expect(r.probes.every((p) => p.outcome === 'unchanged')).toBe(true);
  });
  it('kill switch off is unchanged (legacy 3 min zombie path, zero probes) and unknown liveness still waits 15 min', () => {
    const quiet = { ...handoffTimeline(h4, fx), oldChatClosedSec: null };
    const off = simulate(quiet, SHIPPED, { gateEnabled: false });
    expect([r2(off.leaveSec), off.cause, off.probes.length]).toEqual([194.35, 'zombie', 0]);
    const unknown = simulate({ ...quiet, rawLivenessAt: () => 'unknown' }, SHIPPED);
    expect([r2(unknown.leaveSec), unknown.cause, unknown.probes.length]).toEqual([914.35, 'zombie', 0]);
  });
});
