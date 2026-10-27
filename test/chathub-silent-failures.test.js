// PR #81 review follow-ups: irc_line_error redaction (M1), per-DO log cap
// (M2), gigantify post-push failure keeps the plain row (M3), and JSON.parse
// SyntaxError messages never carry chat text to /client-error (M4).
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/worker.js';
import { makeHub } from './helpers/makeHub.js';
import { logEvents } from './helpers/logEvents.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const mk = (n, text = `line ${n}`) =>
  `@display-name=Alice;id=m${n} :alice!alice@alice.tmi.twitch.tv PRIVMSG #testchannel :${text}`;

describe('M1: irc_line_error redacts a message that echoes the line', () => {
  it('an Error embedding the IRC line text logs [redacted], never the chat text', () => {
    const { hub } = makeHub();
    const line = mk(1, 'SECRETCHAT_PAYLOAD');
    hub.pushMessage = () => { throw new Error('bad thing: ' + line); };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      hub.handleIrcData(line);
      const errs = logEvents(spy, 'irc_line_error');
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toBe('[redacted]');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRETCHAT_PAYLOAD');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('M-A: redaction matches any 24-char window of the line', () => {
  const tagged = '@badge-info=;badges=;color=#fff;display-name=N;id=1;room-id=9;tmi-sent-ts=1 :n!n@n PRIVMSG #c :secret body here and more words';
  function logged(message) {
    const { hub } = makeHub();
    hub.pushMessage = () => { throw new Error(message); };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      hub.handleIrcData(tagged);
      return logEvents(spy, 'irc_line_error')[0].message;
    } finally {
      spy.mockRestore();
    }
  }
  it('an error quoting only the chat body (past the tag prefix) is redacted', () => {
    expect(logged('bad: secret body here and more')).toBe('[redacted]');
  });
  it('control: an unrelated error message is logged as-is', () => {
    expect(logged('bad shape')).toBe('bad shape');
  });
});

describe('M2: irc_line_error is capped per window', () => {
  it('25 throwing lines log 20; the next window logs one suppressed summary first', () => {
    const { hub } = makeHub();
    hub.pushMessage = () => { throw new Error('boom'); };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      hub.handleIrcData(Array.from({ length: 25 }, (_, i) => mk(i)).join('\r\n'));
      expect(logEvents(spy, 'irc_line_error')).toHaveLength(20);
      expect(logEvents(spy, 'irc_line_error_suppressed')).toHaveLength(0);
      expect(hub.ircMsgCount).toBe(25); // every line was still processed

      spy.mockClear();
      now += 60_000;
      hub.handleIrcData(mk(99));
      const order = spy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev && e.ev.startsWith('irc_line_error'));
      expect(order.map((e) => e.ev)).toEqual(['irc_line_error_suppressed', 'irc_line_error']);
      expect(order[0]).toMatchObject({ suppressed: 5, windowMs: 60_000 });
    } finally {
      nowSpy.mockRestore();
      spy.mockRestore();
    }
  });

  it('a later line after a capped burst still lands', () => {
    const { hub } = makeHub();
    const real = hub.pushMessage.bind(hub);
    let n = 0;
    hub.pushMessage = (...a) => { if (++n <= 25) throw new Error('boom'); return real(...a); };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      hub.handleIrcData(Array.from({ length: 26 }, (_, i) => mk(i, 'text ' + i)).join('\r\n'));
    } finally {
      spy.mockRestore();
    }
    expect(hub.ring.map((m) => m.text)).toEqual(['text 25']);
  });
});

describe('M3: a failing gigantify step keeps the plain row', () => {
  const cases = [
    {
      label: 'markPointsGigantify throws after setting fields',
      sabotage: (hub) => {
        hub.consumePendingGigantify = () => ({ points: true, emoteId: 'e1', emoteName: 'Kappa' });
        hub.markPointsGigantify = (entry) => { entry.pointsGigantify = true; entry.emote = { id: 'e1', name: 'Kappa' }; throw new Error('boom'); };
      },
    },
    {
      label: 'markSuperseded throws after setting superseded',
      sabotage: (hub) => {
        hub.consumePendingGigantify = () => ({ emoteId: 'e1', emoteName: 'Kappa', ts: 1 });
        hub.markSuperseded = (entry) => { entry.superseded = true; throw new Error('boom'); };
      },
    },
  ];

  it.each(cases)('$label', ({ sabotage }) => {
    const { hub } = makeHub();
    const enqueued = [];
    const controller = { desiredSize: 1, close() {}, enqueue: (b) => enqueued.push(b) };
    hub.clients.add(controller);
    hub.clientMeta.set(controller, { sseId: 's1', openedAt: Date.now(), strikes: 0 });
    sabotage(hub);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      hub.handleIrcData([mk(1, 'plain one'), mk(2, 'plain two')].join('\r\n'));
      const errs = logEvents(spy, 'irc_line_error');
      // Both lines hit the sabotaged step (consume is stubbed for every call).
      expect(errs.length).toBeGreaterThanOrEqual(1);
      expect(errs.every((e) => e.stage === 'gigantify')).toBe(true);
      expect(errs.every((e) => e.ev === 'irc_line_error' && e.message === 'boom')).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(hub.ring.map((m) => m.text)).toEqual(['plain one', 'plain two']);
    for (const row of hub.ring) {
      expect(row).not.toHaveProperty('pointsGigantify');
      expect(row).not.toHaveProperty('superseded');
      expect(row).not.toHaveProperty('emote');
    }
    expect(enqueued).toHaveLength(2); // one plain broadcast per row, nothing half-applied
  });

  it('the next line still lands after a gigantify failure', () => {
    const { hub } = makeHub();
    const real = hub.consumePendingGigantify.bind(hub);
    let first = true;
    hub.consumePendingGigantify = (...a) => {
      if (first) { first = false; return { points: true, emoteId: 'e1', emoteName: 'K' }; }
      return real(...a);
    };
    hub.markPointsGigantify = (entry) => { entry.pointsGigantify = true; throw new Error('boom'); };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      hub.handleIrcData([mk(1), mk(2)].join('\r\n'));
      expect(logEvents(spy, 'irc_line_error')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect(hub.ring).toHaveLength(2);
    expect(hub.ring[0]).not.toHaveProperty('pointsGigantify');
  });
});

describe('M4: SyntaxError messages never carry chat text to /client-error', () => {
  const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };
  const BAD = 'abc secretchat';

  async function extractScript(url) {
    const res = await worker.fetch(new Request(url), env, {});
    const html = await res.text();
    return html.match(/<script>([\s\S]*?)<\/script>/)[1];
  }
  // JSON.parse override: the one frame containing the marker throws a real
  // V8 SyntaxError whose message embeds BAD; everything else parses normally.
  const jsonWithBadFrame = {
    stringify: JSON.stringify,
    parse: (s, ...r) => (String(s).includes('badframe') ? JSON.parse(BAD) : JSON.parse(s, ...r)),
  };
  const OK_SHAPE = /^SyntaxError( at position \d+| at line \d+ column \d+)?$/;

  it('sanity: V8 really embeds the input in the SyntaxError message', () => {
    let msg = '';
    try { JSON.parse(BAD); } catch (e) { msg = e.message; }
    expect(msg).toContain('secretchat');
  });

  it('overlay onmessage: beacon message is name + position only', async () => {
    const script = await extractScript('https://x/overlay?t=y');
    const calls = [];
    const { fire } = driveClientScriptSession(script, {
      fetch: (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); },
      extraGlobals: { JSON: jsonWithBadFrame },
    });
    fire({ x: 'badframe' });
    const errs = calls.filter((c) => c.url.startsWith('/client-error'));
    expect(errs).toHaveLength(1);
    expect(errs[0].body.message).not.toContain('secretchat');
    expect(errs[0].body.message).toMatch(OK_SHAPE);
  });

  it('PWA sse-mark: beacon message is name + position only', async () => {
    const script = await extractScript('https://x/#t=x');
    const { fireEvent, sentBeacons } = driveClientScriptSession(script, {
      extraGlobals: { JSON: jsonWithBadFrame },
    });
    fireEvent('mark', { x: 'badframe' });
    const errs = sentBeacons.filter((b) => b.url.includes('/client-error'));
    expect(errs).toHaveLength(1);
    const msg = JSON.parse(errs[0].body).message;
    expect(msg).not.toContain('secretchat');
    expect(msg).toMatch(OK_SHAPE);
  });

  it('PWA sse-onmessage: beacon message is name + position only', async () => {
    const script = await extractScript('https://x/#t=x');
    const { fire, sentBeacons } = driveClientScriptSession(script, {
      extraGlobals: { JSON: jsonWithBadFrame },
    });
    fire({ x: 'badframe' });
    const errs = sentBeacons.filter((b) => b.url.includes('/client-error'));
    expect(errs).toHaveLength(1);
    const msg = JSON.parse(errs[0].body).message;
    expect(msg).not.toContain('secretchat');
    expect(msg).toMatch(OK_SHAPE);
  });

  it('non-SyntaxError messages keep their byte-for-byte shape', async () => {
    const script = await extractScript('https://x/overlay?t=y');
    const calls = [];
    const { fireEvent } = driveClientScriptSession(script, {
      fetch: (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); },
      extraGlobals: { CSS: { escape: () => { throw new Error('boom'); } } },
    });
    fireEvent('mark', { action: 'delete', platform: 'tw', targetId: 'm1' });
    expect(calls.find((c) => c.url.startsWith('/client-error')).body.message).toBe('Error: boom');
  });

  async function postClientError(message) {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await worker.fetch(new Request('https://x/client-error?t=x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      }), env, {});
      expect(res.status).toBe(200);
      return logEvents(logSpy, 'client_error');
    } finally {
      logSpy.mockRestore();
    }
  }

  it('server: a SyntaxError message from an old client is reduced before logging', async () => {
    const events = await postClientError('SyntaxError: Unexpected token \'a\', "abc secretchat" is not valid JSON');
    expect(events).toHaveLength(1);
    expect(events[0].message).not.toContain('secretchat');
    expect(events[0].message).toBe('SyntaxError');
  });

  it('server: keeps the position when the message carries one', async () => {
    const events = await postClientError('SyntaxError: Unexpected token a in JSON at position 7 secretchat');
    expect(events[0].message).toBe('SyntaxError at position 7');
  });

  it('server: other messages are logged unchanged', async () => {
    const events = await postClientError('TypeError: x is not a function');
    expect(events[0].message).toBe('TypeError: x is not a function');
  });
});
