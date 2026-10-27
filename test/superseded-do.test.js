// DO superseded detector (feature/yt-chip-reconnect). When Cloudflare moves or
// restarts the ChatHub Durable Object while a client's SSE stream is open,
// the OLD instance stays alive serving that stream (and its IRC socket) but
// stops receiving alarms and ingest — the alarm chain now belongs to the new
// instance. The old instance notices in its own heartbeat tick: no alarm for
// more than 3 alarm intervals (3 x WATCHDOG_MS = 180 s) while clients are
// attached, on two consecutive ticks, means superseded -> close every SSE
// stream and the IRC socket (no reconnect) so clients reconnect to the live
// instance. Fake clock throughout; makeHub's ctx.storage.setAlarm is a no-op,
// so alarms are driven by calling hub.alarm() by hand, as the platform would.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeHub } from './helpers/makeHub.js';
import { logEvents } from './helpers/logEvents.js';
import { WATCHDOG_MS, IDLE_DISCONNECT_MS, SUPERSEDED_ALARM_INTERVALS } from '../src/worker.js';

const ALARM_MS = 60_000; // WATCHDOG_MS
const TICK_MS = 25_000; // HEARTBEAT_MS

function fakeController() {
  return { desiredSize: 1, closed: false, close() { this.closed = true; }, enqueue() {} };
}
function fakeSocket() {
  return { closes: [], close(...a) { this.closes.push(a); } };
}

// A hub with N attached fake clients, an "open" fake IRC socket, the Helix
// pollers stubbed out, and the heartbeat running on fake timers.
// probe: what ctx.storage.getAlarm() does on the close strike — 'reject' = this
// instance's storage is gone (superseded, the default), 'resolve' = still healthy.
function setup({ clients = 1, envOverrides = {}, probe = 'reject' } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { hub } = makeHub({ envOverrides });
  hub.ctx.storage.getAlarm = vi.fn(() => (probe === 'reject' ? Promise.reject(new Error('storage-gone')) : Promise.resolve(null)));
  hub.startTwitchViewerPoll = () => {};
  hub.startTwitchFollowerPoll = () => {};
  const controllers = [];
  for (let i = 0; i < clients; i++) {
    const c = fakeController();
    controllers.push(c);
    hub.clients.add(c);
    hub.clientMeta.set(c, { sseId: 's' + i, openedAt: Date.now(), strikes: 0 });
  }
  const socket = fakeSocket();
  hub.socket = socket;
  hub.socketOpen = true;
  hub.lastSeen.tw = Date.now();
  hub.startHeartbeat();
  hub.scheduleWatchdog(); // what handleEvents does on connect
  return { hub, controllers, socket, logSpy };
}

// One platform alarm: IRC stays "alive" so alarm() takes its noop branch.
async function fireAlarm(hub) {
  hub.lastSeen.tw = Date.now();
  await hub.alarm();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('superseded detector', () => {
  it('healthy instance: alarms every 60 s for 10 minutes never trip the detector', async () => {
    const { hub, controllers, socket, logSpy } = setup({ clients: 2 });
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(ALARM_MS);
      await fireAlarm(hub);
    }
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(0);
    expect(logEvents(logSpy, 'do_superseded_close')).toHaveLength(0);
    expect(hub.clients.size).toBe(2);
    expect(controllers.every((c) => !c.closed)).toBe(true);
    expect(socket.closes).toHaveLength(0);
  });

  it('no alarm for > 3 intervals: first tick logs do_superseded_suspect, second consecutive tick closes everything', async () => {
    const { hub, controllers, socket, logSpy } = setup({ clients: 2 });
    const ensure = vi.spyOn(hub, 'ensureTwitchConnected');
    await vi.advanceTimersByTimeAsync(ALARM_MS);
    await fireAlarm(hub); // last alarm the "old" instance ever sees (t = 60 s)
    // ticks at 75, 100, ... 225 (age 165): healthy. First tick with age > 180 s is t = 250 (age 190).
    await vi.advanceTimersByTimeAsync(165_000);
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TICK_MS); // t = 250
    const suspects = logEvents(logSpy, 'do_superseded_suspect');
    expect(suspects).toHaveLength(1);
    expect(suspects[0]).toMatchObject({ ev: 'do_superseded_suspect', ageSec: 190, clients: 2 });
    expect(hub.clients.size).toBe(2); // one strike is not enough
    expect(logEvents(logSpy, 'do_superseded_close')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(TICK_MS); // t = 275: second consecutive strike
    const closes = logEvents(logSpy, 'do_superseded_close');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ ev: 'do_superseded_close', ageSec: 215, clients: 2, ircOpen: true });
    expect(controllers.every((c) => c.closed)).toBe(true);
    expect(hub.clients.size).toBe(0);
    expect(socket.closes).toHaveLength(1);
    expect(hub.socket).toBeNull();
    expect(hub.socketOpen).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
    expect(hub.heartbeatTimer).toBeNull(); // loop stopped
  });

  it('IRC closed without reconnecting: a late ensureTwitchConnected is a no-op until a new client attaches', async () => {
    const { hub } = setup({ clients: 1 });
    const sockets = [];
    vi.stubGlobal('WebSocket', class { constructor() { sockets.push(this); this.addEventListener = () => {}; } close() {} });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await fireAlarm(hub);
      await vi.advanceTimersByTimeAsync(215_000);
      expect(hub.clients.size).toBe(0); // closed
      hub.ensureTwitchConnected(); // e.g. a reconnect setTimeout armed before the close
      expect(sockets).toHaveLength(0);
      expect(hub.connecting).toBe(false);
      // a genuinely new client (fresh SSE connect) re-enables the instance
      hub.handleEvents(new Request('https://x/events'));
      expect(sockets).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a healthy alarm between the two strikes resets the count (no close)', async () => {
    const { hub, controllers, logSpy } = setup({ clients: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    await fireAlarm(hub);
    await vi.advanceTimersByTimeAsync(190_000); // strike 1 has fired
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(1);
    await fireAlarm(hub); // the alarm chain was just late, not gone
    await vi.advanceTimersByTimeAsync(TICK_MS * 4);
    expect(logEvents(logSpy, 'do_superseded_close')).toHaveLength(0);
    expect(controllers[0].closed).toBe(false);
    expect(hub.supersededStrikes).toBe(0);
  });

  it('alarm() records lastAlarmAt (even an idle-teardown alarm with zero clients)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const { hub } = makeHub();
    expect(hub.lastAlarmAt).toBe(0);
    await hub.alarm();
    expect(hub.lastAlarmAt).toBe(5_000_000);
  });

  it('never fires with zero clients, however old the last alarm', async () => {
    const { hub, logSpy } = setup({ clients: 0 });
    hub.lastAlarmAt = Date.now() - 3_600_000;
    hub.watchdogArmedAt = Date.now() - 3_600_000;
    await hub.checkSuperseded();
    await hub.checkSuperseded();
    await hub.checkSuperseded();
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(0);
    expect(logEvents(logSpy, 'do_superseded_close')).toHaveLength(0);
    expect(hub.supersededStrikes).toBe(0);
  });

  it('no alarm timestamp ever recorded and none armed: detector stays quiet', async () => {
    const { hub, logSpy } = setup({ clients: 1 });
    hub.lastAlarmAt = 0;
    hub.watchdogArmedAt = 0;
    vi.setSystemTime(Date.now() + 3_600_000);
    await hub.checkSuperseded();
    await hub.checkSuperseded();
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(0);
    expect(hub.clients.size).toBe(1);
  });

  it('fresh stream after hours of idle: the last alarm is ancient but the watchdog was just armed by the new connect', async () => {
    const { hub, logSpy } = setup({ clients: 0 });
    hub.lastAlarmAt = Date.now() - 6 * 3_600_000; // idle-teardown alarm from the end of the last stream
    const c = fakeController();
    hub.clients.add(c);
    hub.clientMeta.set(c, { sseId: 'new', openedAt: Date.now(), strikes: 0 });
    hub.startHeartbeat();
    hub.watchdogArmedAt = 0; // setup() armed once already; start from "never armed on this stream"
    hub.scheduleWatchdog(); // handleEvents does this on every connect
    await vi.advanceTimersByTimeAsync(TICK_MS * 3);
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(0);
    expect(c.closed).toBe(false);
  });

  it('kill switch MULTICHAT_SUPERSEDED_DETECT="off": detector never runs, even with a long-dead alarm chain', async () => {
    const { hub, controllers, socket, logSpy } = setup({ clients: 2, envOverrides: { MULTICHAT_SUPERSEDED_DETECT: 'off' } });
    await vi.advanceTimersByTimeAsync(ALARM_MS);
    await fireAlarm(hub);
    await vi.advanceTimersByTimeAsync(20 * 60_000); // no more alarms, heartbeat ticking
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(0);
    expect(logEvents(logSpy, 'do_superseded_close')).toHaveLength(0);
    expect(controllers.every((c) => !c.closed)).toBe(true);
    expect(socket.closes).toHaveLength(0);
  });

  it('default is ON: unset, "on" and junk values all leave the detector armed', async () => {
    for (const value of [undefined, 'on', 'true', '']) {
      const { hub, logSpy } = setup({ clients: 1, envOverrides: value === undefined ? {} : { MULTICHAT_SUPERSEDED_DETECT: value } });
      await vi.advanceTimersByTimeAsync(ALARM_MS);
      await fireAlarm(hub);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(logEvents(logSpy, 'do_superseded_close'), `value=${String(value)}`).toHaveLength(1);
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('a throwing controller.close() or socket.close() is logged with its reason and teardown still completes', async () => {
    const { hub, controllers, socket } = setup({ clients: 2 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    controllers[0].close = () => { throw new Error('ctl-boom'); };
    socket.close = () => { throw new Error('sock-boom'); };
    await vi.advanceTimersByTimeAsync(300_000);
    expect(hub.clients.size).toBe(0);
    expect(controllers[1].closed).toBe(true);
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('sock-boom');
    expect(hub.socket).toBeNull();
  });

  it('close strike with a healthy storage probe: do_superseded_false_alarm, strikes reset, nothing closed, getAlarm never replaced by setAlarm', async () => {
    const { hub, controllers, socket, logSpy } = setup({ clients: 2, probe: 'resolve' });
    const setAlarm = vi.spyOn(hub.ctx.storage, 'setAlarm');
    await vi.advanceTimersByTimeAsync(ALARM_MS);
    await fireAlarm(hub);
    setAlarm.mockClear();
    await vi.advanceTimersByTimeAsync(165_000 + TICK_MS); // t = 250: strike 1
    expect(logEvents(logSpy, 'do_superseded_suspect')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TICK_MS); // t = 275: strike 2 -> probe says alive
    expect(hub.ctx.storage.getAlarm).toHaveBeenCalledTimes(1);
    const fa = logEvents(logSpy, 'do_superseded_false_alarm');
    expect(fa).toHaveLength(1);
    expect(fa[0]).toMatchObject({ ev: 'do_superseded_false_alarm', ageSec: 215, clients: 2 });
    expect(logEvents(logSpy, 'do_superseded_close')).toHaveLength(0);
    expect(hub.supersededStrikes).toBe(0);
    expect(hub.clients.size).toBe(2);
    expect(controllers.every((c) => !c.closed)).toBe(true);
    expect(socket.closes).toHaveLength(0);
    expect(hub.heartbeatTimer).not.toBeNull();
    expect(setAlarm).not.toHaveBeenCalled(); // the probe must never touch the shared alarm slot
  });

  it('close strike with a rejecting storage probe: closes as before and the close log carries the probe error', async () => {
    const { hub, controllers, logSpy } = setup({ clients: 1, probe: 'reject' });
    await vi.advanceTimersByTimeAsync(ALARM_MS);
    await fireAlarm(hub);
    await vi.advanceTimersByTimeAsync(165_000 + TICK_MS * 2);
    const closes = logEvents(logSpy, 'do_superseded_close');
    expect(closes).toHaveLength(1);
    expect(closes[0].err).toContain('storage-gone');
    expect(logEvents(logSpy, 'do_superseded_false_alarm')).toHaveLength(0);
    expect(controllers[0].closed).toBe(true);
  });

  it('a throw inside the async close path is logged as do_superseded_error step=probe, not an unhandled rejection', async () => {
    const { hub, logSpy } = setup({ clients: 1, probe: 'reject' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    hub.closeSuperseded = () => { throw new Error('close-boom'); };
    await vi.advanceTimersByTimeAsync(ALARM_MS);
    await fireAlarm(hub);
    await vi.advanceTimersByTimeAsync(165_000 + TICK_MS * 2);
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('"step":"probe"');
    expect(logged).toContain('close-boom');
    expect(logEvents(logSpy, 'do_superseded_close')).toHaveLength(0);
  });

  // The live detector (alarm silence > 3 x WATCHDOG_MS) is only safe because
  // the idle-disconnect alarm (IDLE_DISCONNECT_MS, set when the last client
  // leaves) is shorter than that threshold: a longer idle alarm set just before
  // a client reconnects would be the only alarm further out than 60 s, and the
  // reconnected stream would false-trip the detector waiting for it.
  it('IDLE_DISCONNECT_MS stays below the superseded threshold (SUPERSEDED_ALARM_INTERVALS x WATCHDOG_MS)', () => {
    expect(IDLE_DISCONNECT_MS).toBeLessThan(SUPERSEDED_ALARM_INTERVALS * WATCHDOG_MS);
  });
});
