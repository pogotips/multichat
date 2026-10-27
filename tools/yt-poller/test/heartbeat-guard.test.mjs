// The poller's 15s heartbeat tick is a module-level setInterval with an async
// callback: an unguarded throw is an unhandled rejection, which exits the
// process on Node 20. guardTick (watchdog.mjs) is the guard; poller.mjs is
// not import-safe in a test process, so its wiring is pinned by source text,
// and the guard's behaviour is driven for real, including the property the
// fix exists for: after a throwing tick the next tick still runs.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { guardTick, makeGuardedTick } from '../watchdog.mjs';

const src = readFileSync(new URL('../poller.mjs', import.meta.url), 'utf8');

afterEach(() => { vi.useRealTimers(); });

describe('guardTick', () => {
  it('a sync throw resolves, and logs one structured line carrying the reason', async () => {
    const log = vi.fn();
    await expect(guardTick(() => { throw new Error('videos.list exploded'); }, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ ev: 'poller_heartbeat_tick_error', reason: 'Error: videos.list exploded' });
  });

  it('a rejection from an awaited call is caught the same way', async () => {
    const log = vi.fn();
    await expect(guardTick(async () => { await Promise.resolve(); throw new TypeError('bad shape'); }, log)).resolves.toBeUndefined();
    expect(JSON.parse(log.mock.calls[0][0]).reason).toBe('TypeError: bad shape');
  });

  it('a non-Error throw still logs a reason', async () => {
    const log = vi.fn();
    await guardTick(() => { throw 'plain string'; }, log);
    expect(JSON.parse(log.mock.calls[0][0]).reason).toBe('plain string');
  });

  it('a healthy tick logs nothing', async () => {
    const log = vi.fn();
    const fn = vi.fn(async () => {});
    await guardTick(fn, log);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('masks a key= query value and truncates the reason', async () => {
    const log = vi.fn();
    await guardTick(() => { throw new Error('GET https://x/v3/videos?id=1&key=SUPERSECRETKEY failed ' + 'z'.repeat(400)); }, log);
    const { reason } = JSON.parse(log.mock.calls[0][0]);
    expect(reason).not.toContain('SUPERSECRETKEY');
    expect(reason).toContain('key=[redacted]');
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it('masks exact secret values anywhere in the reason (message and embedded URL), not just key=', async () => {
    const log = vi.fn();
    const secrets = ['fake-ingest-secret-ABC123', 'FAKEKEY-xyz789'];
    await guardTick(() => {
      throw new Error('ingest fake-ingest-secret-ABC123 rejected; GET https://x/v3/videos?id=1&token=FAKEKEY-xyz789&k=fake-ingest-secret-ABC123 echoed FAKEKEY-xyz789 ' + 'z'.repeat(300));
    }, log, secrets);
    const { reason } = JSON.parse(log.mock.calls[0][0]);
    expect(reason).not.toContain('fake-ingest-secret-ABC123');
    expect(reason).not.toContain('FAKEKEY-xyz789');
    expect(reason).toContain('[redacted]');
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it('empty and undefined secrets entries are ignored', async () => {
    const log = vi.fn();
    await guardTick(() => { throw new Error('plain failure'); }, log, ['', undefined, null]);
    expect(JSON.parse(log.mock.calls[0][0]).reason).toBe('Error: plain failure');
  });

  it('a throwing logger cannot resurrect the rejection', async () => {
    await expect(guardTick(() => { throw new Error('x'); }, () => { throw new Error('logger down'); })).resolves.toBeUndefined();
  });

  it('under a real interval, a throwing tick does not stop the next tick and nothing goes unhandled', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let calls = 0;
    const tick = async () => { calls++; if (calls === 1) throw new Error('first tick dies'); };
    const id = setInterval(async () => { await guardTick(tick, log); }, 15_000);
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    clearInterval(id);
    expect(calls).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('makeGuardedTick (in-flight guard)', () => {
  it('a 40s tick under a 15s interval skips ticks 2 and 3 with one line each, then tick 4 runs', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let started = 0;
    const slow = async () => { started++; await new Promise((r) => setTimeout(r, 40_000)); };
    const runner = makeGuardedTick(slow, log);
    const id = setInterval(runner, 15_000);
    await vi.advanceTimersByTimeAsync(15_000 * 4);
    clearInterval(id);
    // t=15 starts (ends t=55); t=30 and t=45 skip; t=60 runs.
    expect(started).toBe(2);
    const skips = log.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'poller_heartbeat_tick_skipped');
    expect(skips).toHaveLength(2);
    expect(skips[0]).toEqual({ ev: 'poller_heartbeat_tick_skipped', reason: 'in_flight' });
  });

  it('a throwing tick still clears in-flight so the next tick runs', async () => {
    const log = vi.fn();
    let calls = 0;
    const runner = makeGuardedTick(async () => { calls++; throw new Error('boom'); }, log);
    await runner();
    await runner();
    expect(calls).toBe(2);
    const evs = log.mock.calls.map((c) => JSON.parse(c[0]).ev);
    expect(evs).toEqual(['poller_heartbeat_tick_error', 'poller_heartbeat_tick_error']);
  });

  it('passes secrets through to the error masking', async () => {
    const log = vi.fn();
    const runner = makeGuardedTick(() => { throw new Error('leak FAKEKEY-xyz789'); }, log, ['FAKEKEY-xyz789']);
    await runner();
    expect(JSON.parse(log.mock.calls[0][0]).reason).not.toContain('FAKEKEY-xyz789');
  });
});

describe('poller.mjs heartbeat wiring', () => {
  it('the interval only ever runs the tick through makeGuardedTick (guardTick + in-flight skip)', () => {
    expect(src).toContain('async function heartbeatTick(ctx) {');
    expect(src).toContain('const heartbeatRunner = makeGuardedTick(heartbeatTick, console.log, LOG_SECRETS, { onCeiling: watchdogOnCeiling });');
    expect(src).toContain('setInterval(heartbeatRunner, HEARTBEAT_INTERVAL_MS);');
    // declaration + the single makeGuardedTick argument: no unguarded invocation, no raw setInterval(heartbeatTick)
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code.match(/\bheartbeatTick\b/g)).toHaveLength(2);
  });

  it('heartbeatTick runs the watchdog and the per-cycle resets in a finally, fetch/post in the try', () => {
    const start = src.indexOf('async function heartbeatTick(ctx) {');
    const end = src.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    const tryAt = body.indexOf('\n  try {');
    const finallyAt = body.indexOf('\n  } finally {');
    expect(tryAt).toBeGreaterThan(-1);
    expect(finallyAt).toBeGreaterThan(tryAt);
    const tryBlock = body.slice(tryAt, finallyAt);
    const finallyBlock = body.slice(finallyAt);
    expect(tryBlock).toContain('await fetchYtVideoState(');
    expect(tryBlock).toContain('await post(');
    // the finally hands off to runWatchdogAndReset unless the tick went stale
    expect(finallyBlock).toContain("if (!ctx.dropIfStale('watchdog')) runWatchdogAndReset(liveness, watchdogThresholdMin);");
    // stale drops sit before the state write and before the post
    expect(tryBlock.indexOf("ctx.dropIfStale('state')")).toBeLessThan(tryBlock.indexOf('lastLiveness = videoState.liveness'));
    expect(tryBlock.indexOf("ctx.dropIfStale('post')")).toBeLessThan(tryBlock.indexOf('await post('));
    // fallback liveness is computed before the try so finally always has one
    expect(body.slice(0, tryAt)).toMatch(/let liveness = resolveLiveness\(/);
    expect(body.slice(0, tryAt)).toMatch(/let \{ min: watchdogThresholdMin \}/);
    // finally does not swallow: no catch clause
    expect(body).not.toMatch(/\} catch\b/);
  });

  it('runWatchdogAndReset reads cycleFetched BEFORE the resets zero it, resets in an inner finally', () => {
    const start = src.indexOf('function runWatchdogAndReset(liveness, watchdogThresholdMin) {');
    const end = src.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, end);
    const tickAt = fn.indexOf('const tick = watchdogTick(');
    const zeroAt = fn.indexOf('zeroStreak = tick.zeroStreak');
    const resetsFrom = fn.indexOf('cycleFetched = 0;');
    expect(tickAt).toBeGreaterThan(-1);
    expect(zeroAt).toBeGreaterThan(tickAt);
    expect(resetsFrom).toBeGreaterThan(zeroAt);
    expect(fn.indexOf('cycleGlobalEmojiRenders = 0;')).toBeGreaterThan(resetsFrom);
    // the resets sit in a finally after the watchdog try, so a throw from
    // watchdogTick / currentLiveChat.stop cannot skip them
    const innerTry = fn.indexOf('\n  try {');
    const innerFinally = fn.indexOf('\n  } finally {');
    expect(innerTry).toBeGreaterThan(-1);
    expect(tickAt).toBeGreaterThan(innerTry);
    expect(innerFinally).toBeGreaterThan(zeroAt);
    expect(resetsFrom).toBeGreaterThan(innerFinally);
    expect(fn).not.toMatch(/\} catch\b/);
  });

  it('the ceiling release runs the same watchdog from the last liveness sample', () => {
    const start = src.indexOf('function watchdogOnCeiling() {');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('sampleState: lastLiveness.state');
    expect(body).toContain('selectWatchdogThreshold(');
    expect(body).toContain('runWatchdogAndReset(liveness, min);');
  });

  it('a stale tick\'s late heartbeat send cannot touch rtt / cycleFailed / noteSendStatus', () => {
    const start = src.indexOf('async function sendOnce(msg, ctx) {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain('const stale = () => Boolean(ctx && ctx.isStale());');
    // every accounting write is behind the stale check
    expect(body).toContain('if (!stale()) { recordRtt(performance.now() - rttStart); noteSendStatus(msg, res.ok ? undefined : res.status); }');
    expect(body).toContain('if (!stale()) { recordRtt(performance.now() - rttStart); noteSendStatus(msg, undefined); }');
    expect(body).toContain("if (msg.type !== 'heartbeat' && !stale()) {");
    expect(body).toContain("if (msg.type !== 'heartbeat' && !stale()) cycleFailed++;");
    expect(body).not.toMatch(/^\s*recordRtt\(/m);
    expect(src).toContain('return sendOnce(msg, ctx);');
    expect(src).toContain('async function post(msg, ctx) {');
    expect(src).toContain('const status = await post({');
    expect(src).toMatch(/\.\.\.\(counts \|\| \{\}\),\n    \}, ctx\);/);
  });

  it('the old unguarded inline async interval body is gone', () => {
    expect(src).not.toContain('setInterval(async () => {\n  const videoId');
  });
});
