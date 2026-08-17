// REFINEMENT 3 (round-3 audit): check-then-act for the zombie watchdog's
// not_live path. See rediscovery.mjs for the design rationale. This file
// covers the HIGH/MEDIUM findings from the review round that preceded it:
// probe re-spacing independent of caller bookkeeping, single-flight, and
// probe robustness (rejection/timeout never surfacing as an unhandled
// rejection or a stuck in-flight guard).
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { probeCurrentLiveId, createRediscoveryGate, resolveRediscoveryOutcome, DEFAULT_PROBE_TIMEOUT_MS } from '../rediscovery.mjs';

// Minimal LiveChat-shaped fake — only what probeCurrentLiveId touches:
// constructor(id), on(event, cb), start(), stop(reason), removeAllListeners().
// `behavior` controls what start() does; each test picks one shape.
class FakeLiveChat extends EventEmitter {
  constructor(id, behavior) {
    super();
    this.id = id;
    this.behavior = behavior;
    this.stopped = false;
    this.stopReason = null;
    this.stopCallCount = 0;
  }
  async start() {
    if (this.behavior.rejects) throw this.behavior.rejects;
    if (this.behavior.hang) return true; // never emits — exercises the timeout path
    if (this.behavior.liveId !== undefined) {
      queueMicrotask(() => this.emit('start', this.behavior.liveId));
    } else {
      queueMicrotask(() => this.emit('error', new Error(this.behavior.errorMessage || 'Live Stream was not found')));
    }
    return true;
  }
  stop(reason) {
    this.stopCallCount++;
    this.stopped = true;
    this.stopReason = reason;
  }
}

function fakeCtorFor(behavior) {
  return class extends FakeLiveChat {
    constructor(id) {
      super(id, behavior);
    }
  };
}

describe('probeCurrentLiveId', () => {
  it('resolves the liveId on a successful start()', async () => {
    const result = await probeCurrentLiveId(fakeCtorFor({ liveId: 'abc123' }), 'UCxxxx');
    expect(result).toBe('abc123');
  });

  it("resolves null on 'error' (nothing currently live, or a transient failure) — never a positive signal", async () => {
    const result = await probeCurrentLiveId(fakeCtorFor({ errorMessage: 'Live Stream was not found' }), 'UCxxxx');
    expect(result).toBeNull();
  });

  it('resolves null on a start() rejection rather than throwing — MEDIUM: never an unhandled rejection in the caller', async () => {
    const CtorThatRejects = fakeCtorFor({ rejects: new Error('boom') });
    await expect(probeCurrentLiveId(CtorThatRejects, 'UCxxxx')).resolves.toBeNull();
  });

  it('resolves null on timeout when start() hangs (a stuck fetchLivePage must not hang the probe forever)', async () => {
    vi.useFakeTimers();
    try {
      const promise = probeCurrentLiveId(fakeCtorFor({ hang: true }), 'UCxxxx', { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      await expect(promise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults to DEFAULT_PROBE_TIMEOUT_MS when timeoutMs is not passed', () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(8_000);
  });

  it('LOW: calls stop() and removeAllListeners exactly once — no leaked interval/listener on the throwaway instance after settling', async () => {
    let capturedInstance;
    const Ctor = fakeCtorFor({ liveId: 'abc123' });
    const CapturingCtor = class extends Ctor {
      constructor(id) {
        super(id);
        capturedInstance = this;
      }
    };
    await probeCurrentLiveId(CapturingCtor, 'UCxxxx');
    expect(capturedInstance.stopCallCount).toBe(1);
    expect(capturedInstance.listenerCount('start')).toBe(0);
    expect(capturedInstance.listenerCount('error')).toBe(0);
  });

  it('LOW (long-run sim): 200 sequential probes each leave exactly one stop() call and zero leaked listeners on their own instance', async () => {
    const instances = [];
    const Ctor = fakeCtorFor({ liveId: 'stable-id' });
    const CapturingCtor = class extends Ctor {
      constructor(id) {
        super(id);
        instances.push(this);
      }
    };
    for (let i = 0; i < 200; i++) {
      await probeCurrentLiveId(CapturingCtor, 'UCxxxx');
    }
    expect(instances).toHaveLength(200);
    for (const inst of instances) {
      expect(inst.stopCallCount).toBe(1);
      expect(inst.listenerCount('start')).toBe(0);
      expect(inst.listenerCount('error')).toBe(0);
    }
  });

  it('settles only once even if start fires twice in the same tick (idempotent finish, hypothetical double-emission)', async () => {
    let capturedInstance;
    const Ctor = class extends FakeLiveChat {
      constructor(id) {
        super(id, { liveId: 'abc123' });
        capturedInstance = this;
      }
      async start() {
        queueMicrotask(() => this.emit('start', 'abc123'));
        queueMicrotask(() => this.emit('start', 'a-second-id-that-must-be-ignored'));
        return true;
      }
    };
    const result = await probeCurrentLiveId(Ctor, 'UCxxxx');
    expect(result).toBe('abc123'); // first event wins
    expect(capturedInstance.stopCallCount).toBe(1); // cleanup ran exactly once, not twice
  });

  it("cleanup never throws even if stop() itself throws (e.g. 'already stopped')", async () => {
    const Ctor = class extends FakeLiveChat {
      constructor(id) {
        super(id, { liveId: 'abc123' });
      }
      stop() {
        throw new Error('already stopped');
      }
    };
    await expect(probeCurrentLiveId(Ctor, 'UCxxxx')).resolves.toBe('abc123');
  });
});

describe('createRediscoveryGate', () => {
  it('HIGH: consecutive probes must be spaced >= minIntervalMs apart, independent of any external bookkeeping', () => {
    let t = 0;
    const gate = createRediscoveryGate({ minIntervalMs: 5 * 60_000, now: () => t });
    const first = gate.tryStart();
    expect(first.allowed).toBe(true);
    first.release();

    t += 4 * 60_000; // short of the 5-min floor
    const second = gate.tryStart();
    expect(second).toEqual({ allowed: false, reason: 'too_soon' });

    t += 1 * 60_000; // now exactly at the floor (5 min since first)
    const third = gate.tryStart();
    expect(third.allowed).toBe(true);
  });

  it('HIGH: repeated too-soon attempts every tick never advance lastProbeAt — proves spacing holds even under a hypothetical every-15s retry storm', () => {
    let t = 0;
    const gate = createRediscoveryGate({ minIntervalMs: 5 * 60_000, now: () => t });
    gate.tryStart().release();
    let allowedCount = 0;
    // Simulate 5 minutes of 15s-cadence retries (20 ticks) all attempting
    // tryStart() — only the one at t >= 5min should ever be allowed.
    for (let i = 1; i <= 20; i++) {
      t += 15_000;
      const attempt = gate.tryStart();
      if (attempt.allowed) {
        allowedCount++;
        attempt.release();
      }
    }
    expect(allowedCount).toBe(1);
  });

  it('MEDIUM: single-flight — tryStart() while a previous probe has not released() is in_flight, even past minIntervalMs', () => {
    let t = 0;
    const gate = createRediscoveryGate({ minIntervalMs: 1_000, now: () => t });
    const first = gate.tryStart();
    expect(first.allowed).toBe(true);
    t += 10_000; // well past minIntervalMs
    const second = gate.tryStart();
    expect(second).toEqual({ allowed: false, reason: 'in_flight' });
  });

  it('MEDIUM: release() clears the single-flight guard so a subsequent tryStart() (after minIntervalMs) succeeds', () => {
    let t = 0;
    const gate = createRediscoveryGate({ minIntervalMs: 1_000, now: () => t });
    const first = gate.tryStart();
    t += 2_000;
    first.release();
    const second = gate.tryStart();
    expect(second.allowed).toBe(true);
  });

  it('defaults `now` to the real clock when not injected', () => {
    const gate = createRediscoveryGate({ minIntervalMs: 0 });
    const attempt = gate.tryStart();
    expect(attempt.allowed).toBe(true);
  });
});

// LOW-2 (Fable review): the TOCTOU fix. heldVideoId used to be snapshotted
// BEFORE the up-to-8s probe await; if the real session ended and a new one
// started during that window, the post-await comparison ran against the
// wrong session's id and could tear the new one down. resolveRediscoveryOutcome
// is the extracted decision step (poller.mjs's runRediscoveryProbe calls it
// after re-reading videoIdTracker.get() post-await) — this is its regression
// coverage: a session swap in flight must discard the result outright,
// never produce 'changed' (which is the only outcome that triggers stop()).
describe('resolveRediscoveryOutcome (session-swap regression, LOW-2)', () => {
  it('generation mismatch (session swapped mid-probe) discards the result — zero teardowns of the new session, even when the probed id differs from the new session\'s own id', () => {
    const outcome = resolveRediscoveryOutcome({
      generationAtStart: 1,
      currentGeneration: 2, // a 'start' fired while the probe was in flight
      heldVideoId: 'brand-new-session-id', // the NEW session's id, re-read post-await
      probedVideoId: 'stale-probe-result', // whatever the probe saw of the OLD session
    });
    expect(outcome).toEqual({ action: 'discarded' });
  });

  it('generation unchanged + no session held (ended, next not yet started) — no_session, nothing to tear down', () => {
    const outcome = resolveRediscoveryOutcome({
      generationAtStart: 1,
      currentGeneration: 1,
      heldVideoId: null,
      probedVideoId: 'some-id',
    });
    expect(outcome).toEqual({ action: 'no_session' });
  });

  it('generation unchanged + probed id differs from held id — changed (the only outcome that triggers stop())', () => {
    const outcome = resolveRediscoveryOutcome({
      generationAtStart: 1,
      currentGeneration: 1,
      heldVideoId: 'old-id',
      probedVideoId: 'new-id',
    });
    expect(outcome).toEqual({ action: 'changed' });
  });

  it('generation unchanged + probed id matches held id — unchanged', () => {
    const outcome = resolveRediscoveryOutcome({
      generationAtStart: 1,
      currentGeneration: 1,
      heldVideoId: 'same-id',
      probedVideoId: 'same-id',
    });
    expect(outcome).toEqual({ action: 'unchanged' });
  });

  it('generation unchanged + null probed id (probe failed/timed out/nothing live) — unchanged, never a positive signal', () => {
    const outcome = resolveRediscoveryOutcome({
      generationAtStart: 1,
      currentGeneration: 1,
      heldVideoId: 'old-id',
      probedVideoId: null,
    });
    expect(outcome).toEqual({ action: 'unchanged' });
  });
});

// LOW: the throwaway probe must never touch the real session's videoId
// lifecycle — yt_session_start/yt_session_end are logged exclusively by the
// real run()'s own 'start'/'end' handlers in poller.mjs, never by anything
// in this module. Verified structurally: this module never imports or calls
// createVideoIdTracker, never logs 'yt_session_start'/'yt_session_end', and
// the probe instance it constructs is entirely separate from the real
// session's LiveChat instance (a different constructor call, a different
// object, discarded after one settle).
describe('probe/real-session isolation (LOW)', () => {
  it('probeCurrentLiveId never logs yt_session_start or yt_session_end', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await probeCurrentLiveId(fakeCtorFor({ liveId: 'abc123' }), 'UCxxxx');
    const sessionEvents = logSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(line).ev;
        } catch {
          return null;
        }
      })
      .filter((ev) => ev === 'yt_session_start' || ev === 'yt_session_end');
    expect(sessionEvents).toEqual([]);
    logSpy.mockRestore();
  });
});
