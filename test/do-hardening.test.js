import { describe, it, expect, vi } from 'vitest';
import { ChatHub, isProtocolNoise } from '../src/worker.js';
import { makeHub } from './helpers/makeHub.js';
import { logEvents } from './helpers/logEvents.js';
import { withFakeTimers } from './helpers/withFakeTimers.js';

// Shared by 'zombie-controller reaping' and the sse_close reason-mapping
// table below -- both drive reapDeadClients() against a fake SSE controller.
function fakeController(desiredSize) {
  return { desiredSize, closed: false, close() { this.closed = true; }, enqueue() {} };
}
function attach(hub, controller, openedAt = Date.now()) {
  hub.clients.add(controller);
  hub.clientMeta.set(controller, { sseId: 's' + hub.clients.size, openedAt, strikes: 0 });
}

describe('capture liveness (2.4): which IRC lines reach R2', () => {
  // A synthetic command no parser claims and that isn't connection scaffolding,
  // so it falls through handleIrcData to the capture sink. Asserting the guard
  // first means "bucket empty" is provably good news, not a broken write path.
  const unclassifiedLine = '@foo=bar :tmi.twitch.tv ZZZUNKNOWN #testchannel :surprise payload';

  it('the fixture line is genuinely unclassified (not protocol noise)', () => {
    expect(isProtocolNoise(unclassifiedLine)).toBe(false);
  });

  it.each([
    {
      label: 'an unclassified line drives the parse path and fires a CAPTURE.put',
      line: unclassifiedLine,
      captured: true,
      bodyContains: 'surprise payload',
      extraCheck: (hub, putCalls) => {
        expect(putCalls[0].key).toMatch(/^capture\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.ndjson$/);
      },
    },
    {
      label: 'a classified line (PRIVMSG) is NOT captured',
      line: '@display-name=Alice :alice!alice@alice.tmi.twitch.tv PRIVMSG #testchannel :hi',
      captured: false,
    },
    {
      label: 'a PONG reply to our own keepalive PING is not captured to R2',
      line: ':tmi.twitch.tv PONG tmi.twitch.tv :ka1',
      captured: false,
    },
    {
      // sharedchatnotice (PR #38's 2026-08-08 streak coverage audit, §A.1): a
      // wrapper notice type, not in USERNOTICE_KIND/USERNOTICE_SYS, so it
      // already falls through parseUsernotice -> null -> the generic capture
      // sink untouched, same as any other unrecognized msg-id. No rendering,
      // no classification change.
      label: 'a sharedchatnotice USERNOTICE lands whole (untouched) in the capture sink',
      line: '@display-name=ronni;login=ronni;msg-id=sharedchatnotice;source-msg-id=resub;source-room-id=12345;system-msg=ronni\\sresubbed! :tmi.twitch.tv USERNOTICE #dallas',
      captured: true,
      bodyContains: 'msg-id=sharedchatnotice',
      extraCheck: (hub, putCalls) => {
        expect(putCalls[0].body).toContain('source-msg-id=resub');
        expect(hub.ring).toHaveLength(0); // no row rendered — capture-watch only
      },
    },
  ])('$label', async ({ line, captured, bodyContains, extraCheck }) => {
    const { hub, putCalls } = makeHub();
    hub.handleIrcData(line);
    // pushCapture only auto-flushes at the burst threshold; force the flush the
    // teardown paths (alarm/socket-close) would otherwise trigger.
    await hub.flushCapture();
    expect(putCalls).toHaveLength(captured ? 1 : 0);
    if (bodyContains) expect(putCalls[0].body).toContain(bodyContains);
    if (extraCheck) extraCheck(hub, putCalls);
  });

  it('sharedchatnotice logs a shared_chat_notice_capture event naming the inner (source-msg-id) msg-id', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { hub } = makeHub();
    const line = '@display-name=ronni;login=ronni;msg-id=sharedchatnotice;source-msg-id=resub;source-room-id=12345;system-msg=ronni\\sresubbed! :tmi.twitch.tv USERNOTICE #dallas';
    hub.handleIrcData(line);
    expect(logEvents(logSpy, 'shared_chat_notice_capture')).toEqual([{ ev: 'shared_chat_notice_capture', innerMsgId: 'resub' }]);
    logSpy.mockRestore();
  });

  it('sharedchatnotice without a source-msg-id tag still logs, with innerMsgId null', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { hub } = makeHub();
    const line = '@display-name=ronni;login=ronni;msg-id=sharedchatnotice;source-room-id=12345 :tmi.twitch.tv USERNOTICE #dallas';
    hub.handleIrcData(line);
    expect(logEvents(logSpy, 'shared_chat_notice_capture')).toEqual([{ ev: 'shared_chat_notice_capture', innerMsgId: null }]);
    logSpy.mockRestore();
  });

  it('a non-sharedchatnotice USERNOTICE (e.g. resub) never logs shared_chat_notice_capture', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { hub } = makeHub();
    const line = '@display-name=ronni;login=ronni;msg-id=resub;system-msg=ronni\\sresubbed! :tmi.twitch.tv USERNOTICE #dallas';
    hub.handleIrcData(line);
    expect(logEvents(logSpy, 'shared_chat_notice_capture')).toEqual([]);
    logSpy.mockRestore();
  });
});

describe('viewermilestone (watch-streak) renders as a gray info row', () => {
  it('renders sys: viewermilestone, not captured, not gold', async () => {
    const { hub, putCalls } = makeHub();
    const line = '@display-name=airbrake88;login=airbrake88;msg-id=viewermilestone;msg-param-category=watch-streak;msg-param-value=100;system-msg=airbrake88\\swatched\\s100\\sconsecutive\\sstreams\\sand\\ssparked\\sa\\swatch\\sstreak! :tmi.twitch.tv USERNOTICE #dallas';
    hub.handleIrcData(line);
    await hub.flushCapture();
    expect(putCalls).toHaveLength(0);
    expect(hub.ring).toHaveLength(1);
    expect(hub.ring[0]).toMatchObject({
      sys: 'viewermilestone',
      text: 'airbrake88 watched 100 consecutive streams and sparked a watch streak!',
    });
    expect(hub.ring[0].kind).toBeUndefined();
  });
});

describe('zombie-controller reaping (2.5)', () => {
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
  it('sends PING :ka<n> every IRC_KEEPALIVE_MS (60s) while the socket is open, starting at ka1', () => withFakeTimers(() => {
    const { hub } = makeHub();
    const sent = [];
    hub.socket = { send: (msg) => sent.push(msg) };
    hub.startIrcKeepalive();
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual(['PING :ka1', 'PING :ka2', 'PING :ka3']);
  }));

  it('stopIrcKeepalive clears the timer — no sends after stopping', () => withFakeTimers(() => {
    const { hub } = makeHub();
    const sent = [];
    hub.socket = { send: (msg) => sent.push(msg) };
    hub.startIrcKeepalive();
    vi.advanceTimersByTime(60_000);
    hub.stopIrcKeepalive();
    vi.advanceTimersByTime(180_000);
    expect(sent).toEqual(['PING :ka1']);
  }));

  it('starting keepalive again (a reconnect) resets the sequence to ka1, never continuing the prior connection\'s count', () => withFakeTimers(() => {
    const { hub } = makeHub();
    const sent = [];
    hub.socket = { send: (msg) => sent.push(msg) };
    hub.startIrcKeepalive();
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000); // ka1, ka2 on the "old" connection
    hub.startIrcKeepalive(); // simulates ws.onopen firing again after a reconnect
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual(['PING :ka1', 'PING :ka2', 'PING :ka1']);
  }));

  it('no keepalive fires while disconnected — stopIrcKeepalive before any start is a safe no-op', () => withFakeTimers(() => {
    const { hub } = makeHub();
    const sent = [];
    hub.socket = { send: (msg) => sent.push(msg) };
    hub.stopIrcKeepalive(); // never started
    vi.advanceTimersByTime(300_000);
    expect(sent).toEqual([]);
  }));
});

describe('own-keepalive PONG classification', () => {
  const pongLine = ':tmi.twitch.tv PONG tmi.twitch.tv :ka1';

  it('a PONG reply to our own keepalive PING is protocol noise', () => {
    expect(isProtocolNoise(pongLine)).toBe(true);
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

  it('closes the armed socket with a clean 1000 after IRC_RECYCLE_MS', () => withFakeTimers(() => {
    const { hub } = makeHub();
    const ws = fakeSocket();
    hub.socket = ws;
    hub.startIrcRecycle(ws);
    vi.advanceTimersByTime(30 * 60_000);
    expect(ws.closeCalls).toEqual([{ code: 1000, reason: 'recycle' }]);
  }));

  it('stopIrcRecycle clears the timer — no close after stopping', () => withFakeTimers(() => {
    const { hub } = makeHub();
    const ws = fakeSocket();
    hub.socket = ws;
    hub.startIrcRecycle(ws);
    hub.stopIrcRecycle();
    vi.advanceTimersByTime(60 * 60_000);
    expect(ws.closeCalls).toHaveLength(0);
    expect(hub.ircRecycleTimer).toBeNull();
  }));

  // The amendment this guards against: a timer armed for socket A must never
  // fire against socket B after a crash + reconnect swapped this.socket out
  // from under it. Exercised directly (bypassing whatever cleanup path a
  // real reconnect would normally take) so the callback's own guard is what's
  // under test, not the surrounding cleanup plumbing.
  it('generation guard: an orphaned timer armed for a dead socket never closes its replacement', () => withFakeTimers(() => {
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
  }));
});

// Both the keepalive and recycle timers must be torn down on the same two
// exit paths: an abrupt network drop (handleSocketDown) and the alarm's
// idle-teardown branch (zero clients attached). 2 timers x 2 triggers.
describe.each([
  { timerName: 'keepalive timer', timerField: 'ircKeepaliveTimer', start: (hub) => hub.startIrcKeepalive() },
  { timerName: 'recycle timer', timerField: 'ircRecycleTimer', start: (hub, ws) => hub.startIrcRecycle(ws) },
])('$timerName teardown', ({ timerField, start }) => {
  it('handleSocketDown (network-drop path) stops it', () => withFakeTimers(async () => {
    const { hub } = makeHub();
    const ws = { send: () => {}, close: () => {} };
    hub.socket = ws;
    start(hub, ws);
    expect(hub[timerField]).not.toBeNull();
    await hub.handleSocketDown(ws, { code: 1006, reason: '', wasClean: false });
    expect(hub[timerField]).toBeNull();
  }));

  it("alarm's idle-teardown path (clients.size === 0) stops it too", () => withFakeTimers(async () => {
    const { hub } = makeHub();
    const ws = { send: () => {}, close: () => {} };
    hub.socket = ws;
    hub.socketOpen = true;
    start(hub, ws);
    expect(hub[timerField]).not.toBeNull();
    await hub.alarm(); // makeHub starts with zero attached clients
    expect(hub[timerField]).toBeNull();
  }));
});

// dropClient() is the sole `this.clients.delete` site (verified structurally
// below) — every removal path funnels through it and always logs sse_close
// w/ reason. Closes an internal audit's (2026-07-26) vanished-session
// question: the gap there was DO-instance eviction (no controller left to log
// against), not a missing log call on any of these four paths.
describe('sse_close reason coverage per removal path', () => {
  it.each([
    {
      reason: 'backpressure',
      setup: (hub) => {
        const dead = fakeController(-1);
        attach(hub, dead);
        for (let i = 0; i < 5; i++) hub.reapDeadClients();
      },
    },
    {
      reason: 'max-age',
      setup: (hub) => {
        const old = fakeController(4);
        attach(hub, old, Date.now() - 7 * 60 * 60_000); // 7h old, past MAX_SSE_AGE_MS (6h)
        hub.reapDeadClients();
      },
    },
    {
      reason: 'cancel',
      setup: (hub) => {
        const res = hub.handleEvents(new Request('https://do/events'));
        res.body.cancel();
      },
    },
    {
      reason: 'enqueue-error',
      setup: (hub) => {
        const controller = { enqueue() { throw new Error('boom'); } };
        hub.clients.add(controller);
        hub.clientMeta.set(controller, { sseId: 'x', openedAt: Date.now(), strikes: 0 });
        hub.sendToController(controller, { id: 1, kind: 'x' });
      },
    },
  ])('emits sse_close with reason $reason', ({ setup, reason }) => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup(hub);
    expect(logEvents(logSpy, 'sse_close')).toEqual([expect.objectContaining({ reason })]);
    logSpy.mockRestore();
  });

  it('this.clients.delete happens only inside dropClient — no silent removal path exists', () => {
    const src = ChatHub.toString();
    const deleteSites = src.match(/this\.clients\.delete\(/g) || [];
    expect(deleteSites).toHaveLength(1);
  });
});

// Internal forensics doc (2026-08-05), rec 0: nothing logged what a reaped
// connection's backlog looked like, or what a replay actually resurrected vs.
// what it was asked for. These close that gap.
describe('sse_reap_backlog / sse_replay_result (forensics rec 0)', () => {
  it('sse_reap_backlog logs desiredSize/strikes on a backpressure reap', () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dead = fakeController(-3);
    attach(hub, dead);
    for (let i = 0; i < 5; i++) hub.reapDeadClients();
    expect(logEvents(logSpy, 'sse_reap_backlog')).toEqual([
      expect.objectContaining({ sseId: expect.any(String), strikes: expect.any(Number), desiredSize: -3 }),
    ]);
    logSpy.mockRestore();
  });

  it('does not log sse_reap_backlog for a non-backpressure reap reason', () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const old = fakeController(4);
    attach(hub, old, Date.now() - 7 * 60 * 60_000); // past MAX_SSE_AGE_MS
    hub.reapDeadClients();
    expect(logEvents(logSpy, 'sse_reap_backlog')).toEqual([]);
    logSpy.mockRestore();
  });

  it('sse_replay_result logs lastId/matched/range on a replay with matches', () => {
    const { hub } = makeHub();
    hub.ring = [{ id: 10, kind: 'x' }, { id: 11, kind: 'x' }, { id: 12, kind: 'x' }];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = hub.handleEvents(new Request('https://do/events', { headers: { 'Last-Event-ID': '10' } }));
    res.body.cancel();
    expect(logEvents(logSpy, 'sse_replay_result')).toEqual([
      expect.objectContaining({ lastId: 10, matched: 2, sentFrom: 11, sentTo: 12 }),
    ]);
    logSpy.mockRestore();
  });

  it('sse_replay_result logs a zero-match replay (lastId already newest)', () => {
    const { hub } = makeHub();
    hub.ring = [{ id: 5, kind: 'x' }];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = hub.handleEvents(new Request('https://do/events', { headers: { 'Last-Event-ID': '5' } }));
    res.body.cancel();
    expect(logEvents(logSpy, 'sse_replay_result')).toEqual([
      expect.objectContaining({ lastId: 5, matched: 0, sentFrom: null, sentTo: null }),
    ]);
    logSpy.mockRestore();
  });

  it('no sse_replay_result log on a first connect (no Last-Event-ID)', () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = hub.handleEvents(new Request('https://do/events'));
    res.body.cancel();
    expect(logEvents(logSpy, 'sse_replay_result')).toEqual([]);
    logSpy.mockRestore();
  });
});
