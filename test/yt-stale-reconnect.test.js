// YT-chip forced reconnect (feature/yt-chip-reconnect). After Cloudflare moves
// a Durable Object mid-stream, an open SSE stream stays pinned to the OLD
// instance: Twitch keeps flowing (old instance's IRC socket) but the poller's
// YT posts go to the NEW instance, so the old instance's lastSeen.yt ages and
// the YT chip goes red while frames (ping/status) keep arriving — so the plain
// 60 s silence watchdog never fires. Only a fresh connection lands on the live
// instance. These tests pin the pure decision rule, then the real PWA and
// overlay scripts' wiring (driven through vm-page-driver, fake clock).
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/worker.js';
import {
  shouldForceYtReconnect,
  YT_CHIP_RED_MS, YT_FORCE_RED_MS, YT_FORCE_FRAME_FRESH_MS, YT_FORCE_CAP_MS,
} from '../src/lib.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };
const CFG = { redMs: YT_FORCE_RED_MS, frameMs: YT_FORCE_FRAME_FRESH_MS, capMs: YT_FORCE_CAP_MS };

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> in response');
  return m[1];
}
async function pwaScript() {
  const res = await worker.fetch(new Request('https://x/#t=x'), env, {});
  return extractScript(await res.text());
}
async function overlayScript() {
  const res = await worker.fetch(new Request('https://x/overlay?t=y'), env, {});
  return extractScript(await res.text());
}

describe('thresholds', () => {
  it('pin the rule from the spec: red >= 60 s, frame within 60 s, one force per 300 s; chip red cut matches the PWA', () => {
    expect(YT_FORCE_RED_MS).toBe(60_000);
    expect(YT_FORCE_FRAME_FRESH_MS).toBe(60_000);
    expect(YT_FORCE_CAP_MS).toBe(300_000);
    expect(YT_CHIP_RED_MS).toBe(90_000);
  });
});

describe('shouldForceYtReconnect decision table', () => {
  const now = 1_000_000;
  it.each([
    { label: 'chip not red (ytStaleSince null)', s: { ytStaleSince: null, lastFrameAt: now - 1000, lastForcedAt: null }, want: false },
    { label: 'red for 59.999 s with live frames: not yet', s: { ytStaleSince: now - 59_999, lastFrameAt: now - 1000, lastForcedAt: null }, want: false },
    { label: 'red for exactly 60 s with live frames: yes', s: { ytStaleSince: now - 60_000, lastFrameAt: now - 1000, lastForcedAt: null }, want: true },
    { label: 'red for 10 min with live frames, never forced: yes', s: { ytStaleSince: now - 600_000, lastFrameAt: now - 1000, lastForcedAt: null }, want: true },
    { label: 'red >= 60 s but frame 60 s old: yes (boundary inclusive)', s: { ytStaleSince: now - 200_000, lastFrameAt: now - 60_000, lastForcedAt: null }, want: true },
    { label: 'red >= 60 s but silence 60.001 s: no (the stale watchdog owns that)', s: { ytStaleSince: now - 200_000, lastFrameAt: now - 60_001, lastForcedAt: null }, want: false },
    { label: 'forced 299.999 s ago: capped', s: { ytStaleSince: now - 600_000, lastFrameAt: now - 1000, lastForcedAt: now - 299_999 }, want: false },
    { label: 'forced exactly 300 s ago: allowed again', s: { ytStaleSince: now - 600_000, lastFrameAt: now - 1000, lastForcedAt: now - 300_000 }, want: true },
    { label: 'forced 1 s ago: capped', s: { ytStaleSince: now - 600_000, lastFrameAt: now - 1000, lastForcedAt: now - 1000 }, want: false },
  ])('$label', ({ s, want }) => {
    expect(shouldForceYtReconnect({ ...s, now }, CFG)).toBe(want);
  });

  it('is pure: same input, same answer, input untouched', () => {
    const state = { ytStaleSince: 0, lastFrameAt: 190_000, lastForcedAt: null, now: 200_000 };
    const copy = { ...state };
    expect(shouldForceYtReconnect(state, CFG)).toBe(shouldForceYtReconnect(state, CFG));
    expect(state).toEqual(copy);
  });
});

describe('PWA wiring', () => {
  afterEach(() => vi.useRealTimers());

  const redStatus = { tw: 1000, yt: 95_000, counts: {}, ringFloor: null };
  const greenStatus = { tw: 1000, yt: 1000, counts: {}, ringFloor: null };

  function boot() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    return pwaScript().then((script) => driveClientScriptSession(script));
  }
  const ytBeacons = (s) => s.sentBeacons.map((b) => JSON.parse(b.body)).filter((b) => b.kind === 'reconnect_attempt' && b.trigger === 'yt_stale');
  const advance = (ms) => vi.setSystemTime(Date.now() + ms);

  it('red >= 60 s with live frames: the 15 s watchdog poll schedules ONE reconnect, beaconed with trigger yt_stale', async () => {
    const s = await boot();
    s.fireEvent('status', redStatus); // chip turns red here
    advance(100_000);
    s.fireEvent('ping', {}); // frame still arriving: stream is alive
    advance(25_000); // red for 125 s, last frame 25 s ago
    const timersBefore = s.pendingTimerCount();
    s.runIntervals(15_000);
    expect(ytBeacons(s)).toHaveLength(1);
    expect(s.pendingTimerCount()).toBe(timersBefore + 1); // scheduleReconnectAttempt's backoff timer
  });

  it('the scheduled reconnect actually opens a fresh EventSource', async () => {
    const s = await boot();
    s.fireEvent('status', redStatus);
    advance(100_000);
    s.fireEvent('ping', {});
    advance(25_000);
    s.runIntervals(15_000);
    const before = s.getConnectUrls().length;
    s.runTimers(); // backoff timer -> refreshReconnect (version fetch rejects in the driver -> connect() anyway)
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(s.getConnectUrls().length).toBe(before + 1);
  });

  it('red for only 30 s: nothing', async () => {
    const s = await boot();
    s.fireEvent('status', redStatus);
    advance(20_000);
    s.fireEvent('ping', {});
    advance(10_000);
    s.runIntervals(15_000);
    expect(ytBeacons(s)).toHaveLength(0);
  });

  it('red >= 60 s but total silence (> 60 s): yt_stale stays quiet, the plain stale watchdog owns it', async () => {
    const s = await boot();
    s.fireEvent('status', redStatus);
    advance(130_000); // no frames at all since the status
    s.runIntervals(15_000);
    expect(ytBeacons(s)).toHaveLength(0);
    const triggers = s.sentBeacons.map((b) => JSON.parse(b.body).trigger);
    expect(triggers).toContain('watchdog');
  });

  it('silence watchdog tripping does not make a silent stream look frame-fresh: no yt_stale one tick later', async () => {
    const s = await boot();
    s.fireEvent('status', redStatus);
    advance(130_000); // no frames at all since the status
    s.runIntervals(15_000); // silence watchdog trips and re-arms lastActivityTs
    expect(s.sentBeacons.map((b) => JSON.parse(b.body).trigger)).toContain('watchdog');
    advance(15_000); // 145 s since the last real frame
    s.runIntervals(15_000);
    expect(ytBeacons(s)).toHaveLength(0);
  });

  it('chip back to green resets the clock: a later red must again last 60 s', async () => {
    const s = await boot();
    s.fireEvent('status', redStatus);
    advance(100_000);
    s.fireEvent('status', greenStatus); // recovered
    advance(30_000);
    s.fireEvent('status', redStatus); // red again, fresh clock
    advance(30_000);
    s.fireEvent('ping', {});
    s.runIntervals(15_000);
    expect(ytBeacons(s)).toHaveLength(0);
  });

  it('a real poller outage causes at most one forced reconnect per 300 s, then one more after the cap', async () => {
    const s = await boot();
    s.fireEvent('status', redStatus);
    advance(121_000);
    s.fireEvent('ping', {});
    s.runIntervals(15_000);
    expect(ytBeacons(s)).toHaveLength(1);
    // outage continues: the fresh connection's first status frame is still red; frames keep coming
    for (let t = 0; t < 280_000; t += 20_000) {
      advance(20_000);
      s.fireEvent('status', redStatus);
      s.runIntervals(15_000);
    }
    expect(ytBeacons(s)).toHaveLength(1); // still inside the 300 s cap
    advance(30_000); // now > 300 s since the forced reconnect
    s.fireEvent('status', redStatus);
    s.runIntervals(15_000);
    expect(ytBeacons(s)).toHaveLength(2);
  });
});

describe('overlay wiring', () => {
  afterEach(() => vi.useRealTimers());

  const redStatus = { tw: 1000, yt: 95_000, counts: {}, reactions: null };

  async function boot() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const beacons = [];
    const script = await overlayScript();
    const s = driveClientScriptSession(script, {
      fetch: (url, opts) => { beacons.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); },
    });
    return { s, beacons };
  }
  const advance = (ms) => vi.setSystemTime(Date.now() + ms);
  const forced = (beacons) => beacons.filter((b) => b.body.kind === 'reconnect_attempt' && b.body.trigger === 'yt_stale');

  it('registers a 15 s timer', async () => {
    const { s } = await boot();
    expect(s.runIntervals(15_000)).toBe(1);
  });

  it('red >= 60 s with live frames: reconnects through connect() (new EventSource) and beacons yt_stale', async () => {
    const { s, beacons } = await boot();
    s.fireEvent('status', redStatus);
    advance(100_000);
    s.fireEvent('ping', {});
    advance(25_000);
    const before = s.getConnectUrls().length;
    s.runIntervals(15_000);
    expect(s.getConnectUrls().length).toBe(before + 1);
    expect(forced(beacons)).toHaveLength(1);
    expect(beacons[0].url).toContain('/client-error?t=');
  });

  it('red < 60 s: no reconnect', async () => {
    const { s, beacons } = await boot();
    s.fireEvent('status', redStatus);
    advance(30_000);
    const before = s.getConnectUrls().length;
    s.runIntervals(15_000);
    expect(s.getConnectUrls().length).toBe(before);
    expect(forced(beacons)).toHaveLength(0);
  });

  // The overlay has no frame-freshness bookkeeping (no ping listener, no
  // lastFrameAt stamps): it has no silence watchdog to overlap with, so the
  // helper is fed `now` and red alone, bounded by the 300 s cap, decides.
  it('overlay keeps no frame stamps: red >= 60 s reconnects without any ping/message frame since', async () => {
    const { s, beacons } = await boot();
    s.fireEvent('status', redStatus);
    advance(130_000); // no frames at all since the status
    const before = s.getConnectUrls().length;
    s.runIntervals(15_000);
    expect(s.getConnectUrls().length).toBe(before + 1);
    expect(forced(beacons)).toHaveLength(1);
  });

  it('300 s cap between forced reconnects; beacons obey their own 10-per-session budget (not the shared client-error cap) while reconnects keep happening', async () => {
    const { s, beacons } = await boot();
    s.fireEvent('status', redStatus);
    advance(121_000);
    s.fireEvent('ping', {});
    const start = s.getConnectUrls().length;
    s.runIntervals(15_000); // forced #1
    advance(60_000);
    s.fireEvent('status', redStatus);
    s.runIntervals(15_000); // inside cap
    expect(s.getConnectUrls().length).toBe(start + 1);
    for (let i = 0; i < 11; i++) {
      advance(300_000);
      s.fireEvent('status', redStatus);
      s.runIntervals(15_000);
    }
    expect(s.getConnectUrls().length).toBe(start + 12); // 12 forced reconnects total, 300 s apart
    expect(forced(beacons)).toHaveLength(10); // YT_BEACON_SEND_MAX, own budget
  });

  it('chip back to green clears the clock', async () => {
    const { s, beacons } = await boot();
    s.fireEvent('status', redStatus);
    advance(100_000);
    s.fireEvent('status', { ...redStatus, yt: 1000 });
    advance(100_000);
    s.fireEvent('ping', {});
    s.runIntervals(15_000);
    expect(forced(beacons)).toHaveLength(0);
  });
});

describe('embed sites', () => {
  it('overlay-config does NOT embed the helper (nor its timer); PWA and overlay do', async () => {
    const get = async (path) => (await worker.fetch(new Request(`https://x${path}`), env, {})).text();
    expect(await get('/overlay/config?t=y')).not.toContain('shouldForceYtReconnect');
    expect(await get('/#t=x')).toContain('function shouldForceYtReconnect');
    expect(await get('/overlay?t=y')).toContain('function shouldForceYtReconnect');
  });
});
