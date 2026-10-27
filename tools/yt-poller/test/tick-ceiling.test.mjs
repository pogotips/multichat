// A hung tick must not silence the poller longer than TICK_CEILING_MS: the
// guard releases with one log line, the watchdog runs, and the stale tick can
// neither clear the newer tick's guard nor post/write its results.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  makeGuardedTick, TICK_CEILING_MS, HEARTBEAT_INTERVAL_MS, REDISCOVERY_MIN,
} from '../watchdog.mjs';
import { YT_COUNTS_TIMEOUT_MS } from '../yt-counts.mjs';

afterEach(() => { vi.useRealTimers(); });
const evs = (log) => log.mock.calls.map((c) => JSON.parse(c[0]));
const hang = () => new Promise(() => {});

describe('ceiling constant', () => {
  it('is 4 intervals, above every fetch timeout, below the shortest watchdog threshold', () => {
    expect(TICK_CEILING_MS).toBe(4 * HEARTBEAT_INTERVAL_MS);
    expect(TICK_CEILING_MS).toBeGreaterThan(10_000 + YT_COUNTS_TIMEOUT_MS); // post 10s + counts 5s, serial in one tick
    expect(TICK_CEILING_MS).toBeLessThan(REDISCOVERY_MIN * 60_000);
  });
});

describe('makeGuardedTick ceiling', () => {
  it('releases a hung tick at the ceiling: one ev line, watchdog called, next tick runs', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const onCeiling = vi.fn();
    let started = 0;
    const runner = makeGuardedTick(() => { started++; return started === 1 ? hang() : Promise.resolve(); }, log, [], { onCeiling });
    const id = setInterval(runner, HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    clearInterval(id);
    const ceil = evs(log).filter((e) => e.ev === 'poller_tick_ceiling_release');
    expect(ceil).toHaveLength(1);
    expect(ceil[0]).toMatchObject({ reason: 'held_past_ceiling', ceilingMs: TICK_CEILING_MS });
    expect(ceil[0].heldMs).toBeGreaterThanOrEqual(TICK_CEILING_MS);
    expect(onCeiling).toHaveBeenCalledTimes(1);
    expect(started).toBe(2);
    // ticks before the ceiling still skip as before
    expect(evs(log).filter((e) => e.ev === 'poller_heartbeat_tick_skipped')).toHaveLength(3);
  });

  it('a throwing onCeiling is logged and does not block the new tick', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let started = 0;
    const runner = makeGuardedTick(() => { started++; return started === 1 ? hang() : Promise.resolve(); }, log, [],
      { onCeiling: () => { throw new Error('wd boom'); } });
    const id = setInterval(runner, HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    clearInterval(id);
    expect(started).toBe(2);
    expect(evs(log).some((e) => e.ev === 'poller_heartbeat_tick_error')).toBe(true);
  });

  it('stale tick finally leaves the newer tick guard intact', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let releaseStale; let releaseNew;
    let n = 0;
    const runner = makeGuardedTick(() => {
      n++;
      if (n === 1) return new Promise((r) => { releaseStale = r; });
      return new Promise((r) => { releaseNew = r; });
    }, log, [], { onCeiling: () => {} });
    runner(); // tick 1 hangs
    await vi.advanceTimersByTimeAsync(TICK_CEILING_MS);
    runner(); // releases, starts tick 2 (hangs)
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(2);
    releaseStale(); // stale tick 1 resolves late
    await vi.advanceTimersByTimeAsync(0);
    runner(); // tick 2 still in flight -> must skip, not start a third
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(2);
    expect(evs(log).filter((e) => e.ev === 'poller_heartbeat_tick_skipped').length).toBeGreaterThan(0);
    releaseNew();
    await vi.advanceTimersByTimeAsync(0);
    runner();
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(3);
  });

  it('stale tick result is dropped: ctx.dropIfStale true once, logged once; current tick false', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const seen = [];
    let releaseStale;
    let n = 0;
    const runner = makeGuardedTick(async (ctx) => {
      n++;
      if (n === 1) {
        await new Promise((r) => { releaseStale = r; });
        seen.push(['stale-1', ctx.dropIfStale('post')]);
        seen.push(['stale-2', ctx.dropIfStale('state')]);
      } else {
        seen.push(['current', ctx.dropIfStale('post')]);
      }
    }, log, [], { onCeiling: () => {} });
    runner();
    await vi.advanceTimersByTimeAsync(TICK_CEILING_MS);
    await runner();
    releaseStale();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([['current', false], ['stale-1', true], ['stale-2', true]]);
    const dropped = evs(log).filter((e) => e.ev === 'poller_tick_stale_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].what).toBe('post');
  });

  it('normal ticks unchanged: no ceiling ev, no drop, onCeiling never called, ctx.dropIfStale false', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const onCeiling = vi.fn();
    const flags = [];
    const runner = makeGuardedTick(async (ctx) => { await new Promise((r) => setTimeout(r, 2_000)); flags.push(ctx.dropIfStale('post')); }, log, [], { onCeiling });
    const id = setInterval(runner, HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 10);
    clearInterval(id);
    expect(flags.length).toBeGreaterThanOrEqual(9);
    expect(flags.every((f) => f === false)).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(onCeiling).not.toHaveBeenCalled();
  });

  it('ceiling line carries no secret even when the secret is passed', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let n = 0;
    const runner = makeGuardedTick(() => (++n === 1 ? hang() : Promise.resolve()), log, ['FAKESECRET-1'], { onCeiling: () => {} });
    runner();
    await vi.advanceTimersByTimeAsync(TICK_CEILING_MS);
    runner();
    expect(log.mock.calls.flat().join(' ')).not.toContain('FAKESECRET-1');
  });
});

describe('stale tick late send accounting', () => {
  it('ctx.isStale() is false for the current tick, true once released, and never logs', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const seen = [];
    let n = 0;
    let releaseStale;
    const runner = makeGuardedTick(async (ctx) => {
      n++;
      if (n === 1) {
        seen.push(['pre', ctx.isStale()]);
        await new Promise((r) => { releaseStale = r; });
        seen.push(['stale', ctx.isStale()]);
      } else {
        seen.push(['current', ctx.isStale()]);
      }
    }, log, [], { onCeiling: () => {} });
    runner();
    await vi.advanceTimersByTimeAsync(TICK_CEILING_MS);
    await runner();
    releaseStale();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([['pre', false], ['current', false], ['stale', true]]);
    expect(evs(log).filter((e) => e.ev === 'poller_tick_stale_dropped')).toHaveLength(0);
  });
});
