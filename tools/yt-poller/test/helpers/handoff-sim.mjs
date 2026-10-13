// Fake-clock replay harness for the YT handoff blind window. Drives the REAL
// exported decision functions (watchdog.mjs resolveLiveness / watchdogTick,
// rediscovery.mjs createRediscoveryGate / resolveRediscoveryOutcome,
// recovery.mjs classifyYtItem) with a timeline of relative seconds.
//
// What is NOT driven by real code, and why (poller.mjs is not import-safe —
// top-level env check + run() at module scope):
//   - the heartbeat tick body (poller.mjs setInterval, :603-:700) that feeds
//     those functions: re-typed here as the loop in simulate()
//   - the error-path leave (MAX_CONSECUTIVE_ERRORS, poller.mjs:346 / :486)
//   - the reconnect delay (poller.mjs:71 / :316) and runRediscoveryProbe
//     (poller.mjs:555) — probeCurrentLiveId is bypassed, its answer is a
//     timeline input
// Candidate overrides (threshold / rule changes) live only in this file.
import { createRediscoveryGate, resolveRediscoveryOutcome } from '../../rediscovery.mjs';
import {
  watchdogTick as realWatchdogTick, resolveLiveness,
  HEARTBEAT_INTERVAL_MS, REDISCOVERY_MIN, REDISCOVERY_GATE_MS, ZOMBIE_WATCHDOG_CYCLES, LEGACY_ZOMBIE_WATCHDOG_CYCLES,
} from '../../watchdog.mjs';

export const HEARTBEAT_SEC = HEARTBEAT_INTERVAL_MS / 1000;
export const MAX_CONSECUTIVE_ERRORS_TODAY = 8; // poller.mjs:346, not importable
export const RECONNECT_DELAY_TODAY_SEC = 2; // poller.mjs:71 (backoffMs initial), not importable
export const NOT_FOUND_BACKOFF_SEC = 20; // poller.mjs:85
export const ERROR_POLL_SEC = 1; // youtube-chat 1 s poll, one error per poll

// BASELINE_PRE_C1: the values the poller shipped with before the C1 + gate fix
// (REDISCOVERY_MIN 5, probe gate 300 s), driven here as literals so the
// 239-278 s blind window stays reproducible after the constants moved. `TODAY`
// is the same object under its original name (the candidate table below is
// relative to it); the id stays 'today' so the audit's tables read unchanged.
export const BASELINE_PRE_C1 = {
  id: 'today',
  rediscoveryMin: 5,
  gateMinSec: 300,
  flipProbe: false,
  ageProbeSec: null,
  maxErrors: MAX_CONSECUTIVE_ERRORS_TODAY,
  reconnectDelaySec: RECONNECT_DELAY_TODAY_SEC,
};
export const TODAY = BASELINE_PRE_C1;

// What the poller runs now: the REAL exported cadence and gate constants.
export const SHIPPED = {
  ...BASELINE_PRE_C1,
  id: 'shipped',
  rediscoveryMin: REDISCOVERY_MIN,
  gateMinSec: REDISCOVERY_GATE_MS / 1000,
};

// C1..C6 as test-local overrides of TODAY. C7 (recovery caps) is analysis-only:
// recovery.mjs:14-15 are module constants classifyYtItem does not take.
export const CANDIDATES = [
  { ...TODAY, id: 'C1', label: 'REDISCOVERY_MIN 5 -> 2 (threshold cycles and gate interval)', rediscoveryMin: 2, gateMinSec: 120 },
  { ...TODAY, id: 'C2', label: 'probe gate interval 5 min -> 4 min, cadence stays 5 min', gateMinSec: 240 },
  { ...TODAY, id: 'C3', label: 'one extra probe on the live -> not_live flip', flipProbe: true },
  { ...TODAY, id: 'C4', label: 'probe every tick while not_live and last message >= 45 s old', ageProbeSec: 45, gateMinSec: 10 },
  { ...TODAY, id: 'C5', label: 'MAX_CONSECUTIVE_ERRORS 8 -> 3', maxErrors: 3 },
  { ...TODAY, id: 'C6', label: 'reconnect delay 2000 ms -> 500 ms', reconnectDelaySec: 0.5 },
];

// Parameterised copy of watchdog.mjs watchdogTick — only the not_live cycle
// count differs from the real one. The test pins parity against the real
// function for TODAY, so this cannot silently drift from it.
export function replicaTick(c, { liveChatSessionActive, zeroStreak, cycleFetched, liveness, gateEnabled }) {
  if (!liveChatSessionActive) return { zeroStreak: 0, fired: false, event: null };
  if (cycleFetched !== 0) return { zeroStreak: 0, fired: false, event: null };
  const next = zeroStreak + 1;
  const cycles = !gateEnabled
    ? LEGACY_ZOMBIE_WATCHDOG_CYCLES
    : liveness === 'not_live' ? (c.rediscoveryMin * 60) / HEARTBEAT_SEC : ZOMBIE_WATCHDOG_CYCLES;
  if (next >= cycles) {
    const event = gateEnabled && liveness === 'not_live' ? 'yt_rediscovery' : 'zombie_watchdog_reconnect';
    return { zeroStreak: 0, fired: true, event };
  }
  return { zeroStreak: next, fired: false, event: null };
}

const decide = (c, args) => (c.rediscoveryMin === REDISCOVERY_MIN ? realWatchdogTick(args) : replicaTick(c, args));

// Timeline s: { tickPhaseSec, lastMsgSec, oldNotLiveFromSec, oldChatClosedSec|null,
//   probeAnswerAt(t) -> id|null, rawLivenessAt?(t), horizonSec }
// Returns { leaveSec, cause, probes, rediscoveryTeardown }.
export function simulate(s, c, { gateEnabled = true } = {}) {
  let clock = 0;
  const gate = createRediscoveryGate({ minIntervalMs: c.gateMinSec * 1000, now: () => clock * 1000 });
  const rawAt = s.rawLivenessAt || ((t) => (t < s.oldNotLiveFromSec ? 'live' : 'not_live'));
  const errLeave = s.oldChatClosedSec == null ? Infinity : s.oldChatClosedSec + c.maxErrors * ERROR_POLL_SEC;
  const probes = [];
  let streak = 0;
  let prevLiveness = null;
  for (let t = s.tickPhaseSec - HEARTBEAT_SEC; t <= s.horizonSec; t += HEARTBEAT_SEC) {
    if (errLeave <= t) return { leaveSec: errLeave, cause: 'errors', probes, rediscoveryTeardown: false };
    clock = t;
    const cycleFetched = t - HEARTBEAT_SEC < s.lastMsgSec ? 1 : 0;
    const liveness = resolveLiveness({ gateEnabled, sampleState: rawAt(t), sampleAt: t, now: t });
    const tick = decide(c, { liveChatSessionActive: true, zeroStreak: streak, cycleFetched, liveness, gateEnabled });
    streak = tick.zeroStreak;
    if (tick.fired && tick.event === 'zombie_watchdog_reconnect') {
      return { leaveSec: t, cause: 'zombie', probes, rediscoveryTeardown: false };
    }
    let wantProbe = tick.fired && tick.event === 'yt_rediscovery';
    if (c.flipProbe && gateEnabled && prevLiveness === 'live' && liveness === 'not_live') wantProbe = true;
    if (c.ageProbeSec != null && gateEnabled && liveness === 'not_live' && cycleFetched === 0
        && t - s.lastMsgSec >= c.ageProbeSec) wantProbe = true;
    prevLiveness = liveness;
    if (!wantProbe) continue;
    const g = gate.tryStart();
    if (!g.allowed) { probes.push({ t, outcome: g.reason }); continue; }
    const out = resolveRediscoveryOutcome({
      generationAtStart: 1, currentGeneration: 1, heldVideoId: 'stream-old', probedVideoId: s.probeAnswerAt(t),
    });
    g.release();
    probes.push({ t, outcome: out.action });
    if (out.action === 'changed') {
      return { leaveSec: t + s.probeSec, cause: 'rediscovery', probes, rediscoveryTeardown: true };
    }
  }
  return { leaveSec: null, cause: null, probes, rediscoveryTeardown: false };
}

// Blind window = new session start - new stream go-live. If the reconnect
// lands before go-live, poller.mjs retries every NOT_FOUND_BACKOFF_SEC.
export function blindSeconds(leaveSec, h, c, bLiveSec) {
  if (leaveSec == null || bLiveSec == null) return null;
  let start = leaveSec + h.endToStartSec - (RECONNECT_DELAY_TODAY_SEC - c.reconnectDelaySec);
  while (start < bLiveSec) start += NOT_FOUND_BACKOFF_SEC;
  return +(start - bLiveSec).toFixed(2);
}

export function handoffTimeline(h, fx, over = {}) {
  const base = h.path === 'error'
    ? { tickPhaseSec: 14.35, lastMsgSec: 0, oldNotLiveFromSec: 0, oldChatClosedSec: h.oldChatDiedSec }
    : { tickPhaseSec: h.tickPhaseSec, lastMsgSec: 0, oldNotLiveFromSec: h.oldNotLiveFromSec, oldChatClosedSec: h.oldChatClosedSec ?? null };
  const bLive = over.bLiveSec !== undefined ? over.bLiveSec : (h.bLiveSec ?? h.bLiveBorrowedSec ?? null);
  return {
    ...base,
    probeSec: fx.probeSec,
    horizonSec: 1500,
    probeAnswerAt: (t) => (bLive != null && t >= bLive ? fx.heldIdNew : fx.heldIdOld),
    ...over,
  };
}

// Fire-to-fire jitter source: the logged intervals, minus the multi-hour gaps
// (those span a live stream, not a probe cadence).
export const jitterSeries = (fx) => fx.rediscoveryRuns.runs.flatMap((r) => r.intervalsSec).filter((v) => v < 1000);

// Fire-spacing replay: cadence `periodSec`, gate `gateMinSec`, jitter taken
// from the logged fire-to-fire intervals (observed minus 300 s, scaled by
// sqrt(period/300) — independent per-tick jitter grows with sqrt of ticks).
export function tooSoonRun(intervals, periodSec, gateMinSec, hours = 1) {
  let clock = 0;
  const gate = createRediscoveryGate({ minIntervalMs: gateMinSec * 1000, now: () => clock * 1000 });
  const scale = Math.sqrt(periodSec / 300);
  let fires = 0; let skipped = 0; let probes = 0; let t = 0; let i = 0;
  while (t <= hours * 3600) {
    clock = t;
    fires++;
    const g = gate.tryStart();
    if (g.allowed) { probes++; g.release(); } else skipped++;
    t += periodSec + (intervals[i % intervals.length] - 300) * scale;
    i++;
  }
  return { fires, skipped, probes, skipShare: +(skipped / fires).toFixed(3) };
}
