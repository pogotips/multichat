import { describe, it, expect, vi } from 'vitest';
import { ChatHub, isProtocolNoise } from '../src/worker.js';

// Minimal DO harness: ChatHub's constructor only stashes ctx/env, and the
// methods under test here (handleIrcData → pushCapture → flushCapture, and
// reapDeadClients) never touch storage, so stub ctx and mock only what they use.
function makeHub({ capturePut } = {}) {
  const putCalls = [];
  const env = {
    TWITCH_CHANNEL: 'testchannel',
    CAPTURE: {
      async put(key, body) {
        putCalls.push({ key, body });
        if (capturePut) return capturePut(key, body);
      },
    },
  };
  const ctx = { storage: { setAlarm: async () => {} } };
  const hub = new ChatHub(ctx, env);
  return { hub, putCalls };
}

describe('capture liveness (2.4): an unclassified IRC line reaches R2', () => {
  // A synthetic command no parser claims and that isn't connection scaffolding,
  // so it falls through handleIrcData to the capture sink. Asserting the guard
  // first means "bucket empty" is provably good news, not a broken write path.
  const line = '@foo=bar :tmi.twitch.tv ZZZUNKNOWN #testchannel :surprise payload';

  it('the fixture line is genuinely unclassified (not protocol noise)', () => {
    expect(isProtocolNoise(line)).toBe(false);
  });

  it('drives the parse path and fires a CAPTURE.put with the line', async () => {
    const { hub, putCalls } = makeHub();
    hub.handleIrcData(line);
    // pushCapture only auto-flushes at the burst threshold; force the flush the
    // teardown paths (alarm/socket-close) would otherwise trigger.
    await hub.flushCapture();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].key).toMatch(/^capture\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.ndjson$/);
    expect(putCalls[0].body).toContain('surprise payload');
  });

  it('a classified line (PRIVMSG) is NOT captured', async () => {
    const { hub, putCalls } = makeHub();
    hub.handleIrcData('@display-name=Alice :alice!alice@alice.tmi.twitch.tv PRIVMSG #testchannel :hi');
    await hub.flushCapture();
    expect(putCalls).toHaveLength(0);
  });
});

describe('zombie-controller reaping (2.5)', () => {
  function fakeController(desiredSize) {
    return { desiredSize, closed: false, close() { this.closed = true; }, enqueue() {} };
  }
  function attach(hub, controller, openedAt = Date.now()) {
    hub.clients.add(controller);
    hub.clientMeta.set(controller, { sseId: 's' + hub.clients.size, openedAt, strikes: 0 });
  }

  it('evicts a persistently backpressured reader, keeps a healthy one', () => {
    const { hub } = makeHub();
    const dead = fakeController(-1);   // never drains
    const alive = fakeController(4);   // healthy
    attach(hub, dead);
    attach(hub, alive);

    // Below the strike limit it must NOT be closed yet (accumulating strikes).
    hub.reapDeadClients();
    expect(dead.closed).toBe(false);
    expect(hub.clients.has(dead)).toBe(true);

    // Enough consecutive negative ticks → evicted from both clients and meta.
    for (let i = 0; i < 5; i++) hub.reapDeadClients();
    expect(dead.closed).toBe(true);
    expect(hub.clients.has(dead)).toBe(false);
    expect(hub.clientMeta.has(dead)).toBe(false);

    // The healthy reader is untouched throughout.
    expect(alive.closed).toBe(false);
    expect(hub.clients.has(alive)).toBe(true);
  });

  it('backpressure eviction emits sse_close with reason "backpressure"', () => {
    const { hub } = makeHub();
    const dead = fakeController(-1);
    attach(hub, dead);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) hub.reapDeadClients();
    const closes = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'sse_close');
    expect(closes).toEqual([expect.objectContaining({ reason: 'backpressure' })]);
    logSpy.mockRestore();
  });

  it('max-age eviction emits sse_close with reason "max-age"', () => {
    const { hub } = makeHub();
    const old = fakeController(4);
    attach(hub, old, Date.now() - 7 * 60 * 60_000); // 7h old, past MAX_SSE_AGE_MS (6h)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    hub.reapDeadClients();
    const closes = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'sse_close');
    expect(closes).toEqual([expect.objectContaining({ reason: 'max-age' })]);
    logSpy.mockRestore();
  });

  it('a transient negative reading resets the strike counter (no false eviction)', () => {
    const { hub } = makeHub();
    const flaky = fakeController(-1);
    attach(hub, flaky);
    hub.reapDeadClients(); // strike 1
    hub.reapDeadClients(); // strike 2
    flaky.desiredSize = 8; // recovered
    hub.reapDeadClients(); // resets to 0
    flaky.desiredSize = -1;
    hub.reapDeadClients(); // strike 1 again
    expect(flaky.closed).toBe(false);
    expect(hub.clients.has(flaky)).toBe(true);
  });

  it('max-age backstop force-closes a very old stream on the first tick', () => {
    const { hub } = makeHub();
    const old = fakeController(4); // healthy backpressure, but ancient
    attach(hub, old, Date.now() - 7 * 60 * 60_000); // 7h old
    hub.reapDeadClients();
    expect(old.closed).toBe(true);
    expect(hub.clients.has(old)).toBe(false);
  });
});

// Root cause of the ~2-3min tw_close/1006 cadence found via a 2026-07-21
// Observability investigation: the outbound Twitch socket was dying from pure
// network-level silence, upstream of anything this DO controls (watchdog was
// noop almost every tick) or Twitch's own RECONNECT command (zero received).
// A self-sent PING makes Twitch's PONG reply inbound traffic, feeding
// lastSeen.tw exactly like an inbound Twitch PING would, so IRC_SILENCE_MS
// stops betting on Twitch's own ping schedule.
describe('IRC client-initiated keepalive', () => {
  it('sends PING :ka<n> every IRC_KEEPALIVE_MS (60s) while the socket is open, starting at ka1', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const sent = [];
      hub.socket = { send: (msg) => sent.push(msg) };
      hub.startIrcKeepalive();
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000);
      expect(sent).toEqual(['PING :ka1', 'PING :ka2', 'PING :ka3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopIrcKeepalive clears the timer — no sends after stopping', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const sent = [];
      hub.socket = { send: (msg) => sent.push(msg) };
      hub.startIrcKeepalive();
      vi.advanceTimersByTime(60_000);
      hub.stopIrcKeepalive();
      vi.advanceTimersByTime(180_000);
      expect(sent).toEqual(['PING :ka1']);
      expect(hub.ircKeepaliveTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starting keepalive again (a reconnect) resets the sequence to ka1, never continuing the prior connection\'s count', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const sent = [];
      hub.socket = { send: (msg) => sent.push(msg) };
      hub.startIrcKeepalive();
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000); // ka1, ka2 on the "old" connection
      hub.startIrcKeepalive(); // simulates ws.onopen firing again after a reconnect
      vi.advanceTimersByTime(60_000);
      expect(sent).toEqual(['PING :ka1', 'PING :ka2', 'PING :ka1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no keepalive fires while disconnected — stopIrcKeepalive before any start is a safe no-op', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const sent = [];
      hub.socket = { send: (msg) => sent.push(msg) };
      hub.stopIrcKeepalive(); // never started
      vi.advanceTimersByTime(300_000);
      expect(sent).toEqual([]);
      expect(hub.ircKeepaliveTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('handleSocketDown (network-drop path) stops the keepalive timer', async () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const fakeWs = { send: () => {} };
      hub.socket = fakeWs;
      hub.startIrcKeepalive();
      expect(hub.ircKeepaliveTimer).not.toBeNull();
      await hub.handleSocketDown(fakeWs, { code: 1006, reason: '', wasClean: false });
      expect(hub.ircKeepaliveTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("alarm's idle-teardown path (clients.size === 0) stops the keepalive timer too", async () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      hub.socket = { send: () => {}, close: () => {} };
      hub.socketOpen = true;
      hub.startIrcKeepalive();
      expect(hub.ircKeepaliveTimer).not.toBeNull();
      await hub.alarm(); // makeHub starts with zero attached clients
      expect(hub.ircKeepaliveTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('own-keepalive PONG classification', () => {
  const pongLine = ':tmi.twitch.tv PONG tmi.twitch.tv :ka1';

  it('a PONG reply to our own keepalive PING is protocol noise', () => {
    expect(isProtocolNoise(pongLine)).toBe(true);
  });

  it('is not captured to R2', async () => {
    const { hub, putCalls } = makeHub();
    hub.handleIrcData(pongLine);
    await hub.flushCapture();
    expect(putCalls).toHaveLength(0);
  });

  it('does not become a rendered chat/info row', () => {
    const { hub } = makeHub();
    hub.handleIrcData(pongLine);
    expect(hub.ring).toHaveLength(0);
  });
});

// Bounds DO console.log flush latency (logs only flush when the held Twitch
// socket closes — see ARCHITECTURE.md) by cleanly recycling the socket every
// IRC_RECYCLE_MS, independent of the keepalive timer.
describe('IRC socket recycle', () => {
  function fakeSocket() {
    return { closeCalls: [], close(code, reason) { this.closeCalls.push({ code, reason }); } };
  }

  it('closes the armed socket with a clean 1000 after IRC_RECYCLE_MS', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const ws = fakeSocket();
      hub.socket = ws;
      hub.startIrcRecycle(ws);
      vi.advanceTimersByTime(30 * 60_000);
      expect(ws.closeCalls).toEqual([{ code: 1000, reason: 'recycle' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopIrcRecycle clears the timer — no close after stopping', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const ws = fakeSocket();
      hub.socket = ws;
      hub.startIrcRecycle(ws);
      hub.stopIrcRecycle();
      vi.advanceTimersByTime(60 * 60_000);
      expect(ws.closeCalls).toHaveLength(0);
      expect(hub.ircRecycleTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('handleSocketDown (network-drop path) cancels a pending recycle timer', async () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const ws = fakeSocket();
      hub.socket = ws;
      hub.startIrcRecycle(ws);
      expect(hub.ircRecycleTimer).not.toBeNull();
      await hub.handleSocketDown(ws, { code: 1006, reason: '', wasClean: false });
      expect(hub.ircRecycleTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("alarm's idle-teardown path stops a pending recycle timer too", async () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const ws = fakeSocket();
      hub.socket = ws;
      hub.socketOpen = true;
      hub.startIrcRecycle(ws);
      expect(hub.ircRecycleTimer).not.toBeNull();
      await hub.alarm(); // makeHub starts with zero attached clients -> idle-teardown branch
      expect(hub.ircRecycleTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The amendment this guards against: a timer armed for socket A must never
  // fire against socket B after a crash + reconnect swapped this.socket out
  // from under it. Exercised directly (bypassing whatever cleanup path a
  // real reconnect would normally take) so the callback's own guard is what's
  // under test, not the surrounding cleanup plumbing.
  it('generation guard: an orphaned timer armed for a dead socket never closes its replacement', () => {
    vi.useFakeTimers();
    try {
      const { hub } = makeHub();
      const socketA = fakeSocket();
      const socketB = fakeSocket();
      hub.socket = socketA;
      hub.startIrcRecycle(socketA); // timer armed while socketA is current

      // Simulate a crash-reconnect that swapped in a new socket instance
      // WITHOUT going through the normal stopIrcRecycle() cleanup (the
      // scenario the guard exists for).
      hub.socket = socketB;

      vi.advanceTimersByTime(30 * 60_000); // socketA's original 30-min fire point
      expect(socketA.closeCalls).toHaveLength(0); // already "dead" — nothing to close
      expect(socketB.closeCalls).toHaveLength(0); // must NOT touch the new socket
    } finally {
      vi.useRealTimers();
    }
  });
});

// dropClient() is the sole `this.clients.delete` site (verified structurally
// below) — every removal path funnels through it and always logs sse_close
// w/ reason. Closes the STREAM_AUDIT_2026-07-26 vanished-session question:
// the gap there was DO-instance eviction (no controller left to log
// against), not a missing log call on any of these four paths.
describe('sse_close reason coverage per removal path', () => {
  it('client-initiated cancel emits sse_close with reason "cancel"', () => {
    const { hub } = makeHub();
    const res = hub.handleEvents(new Request('https://do/events'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    res.body.cancel();
    const closes = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'sse_close');
    expect(closes).toEqual([expect.objectContaining({ reason: 'cancel' })]);
    logSpy.mockRestore();
  });

  it('a throwing controller.enqueue() emits sse_close with reason "enqueue-error"', () => {
    const { hub } = makeHub();
    const controller = { enqueue() { throw new Error('boom'); } };
    hub.clients.add(controller);
    hub.clientMeta.set(controller, { sseId: 'x', openedAt: Date.now(), strikes: 0 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    hub.sendToController(controller, { id: 1, kind: 'x' });
    const closes = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'sse_close');
    expect(closes).toEqual([expect.objectContaining({ reason: 'enqueue-error' })]);
    logSpy.mockRestore();
  });

  it('this.clients.delete happens only inside dropClient — no silent removal path exists', () => {
    const src = ChatHub.toString();
    const deleteSites = src.match(/this\.clients\.delete\(/g) || [];
    expect(deleteSites).toHaveLength(1);
  });
});
