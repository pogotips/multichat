// fix/sse-auto-recover: unifies every client reconnect trigger (onerror,
// stale watchdog, visibilitychange, manual button/pull) onto one path
// (refreshReconnect), adds client-side id dedupe, a shared backoff curve
// applied to the watchdog too, a bounded in-flight guard, and a structured
// reconnect-attempt beacon. Phase 1 recon (this branch) established:
//   - server already accepts ?lastEventId= (edge handleEvents, worker.js
//     ~line 222) and already sends a status snapshot on open (~line 653) —
//     no server change needed for either, only regression coverage here.
//   - client had NO id-based dedupe, and the watchdog never re-armed
//     lastActivityTs at the moment it attempted a reconnect, so it could
//     re-trip and tear down a socket still CONNECTING every 15s.
import { describe, it, expect } from 'vitest';
import worker, { reconnectBackoffMs, createSeenIdGate } from '../src/worker.js';
import { detectReplayGap } from '../src/lib.js';
import { logEvents } from './helpers/logEvents.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';
import { vi } from 'vitest';

const env = { MULTICHAT_VIEW_SECRET: 'correct-secret' };

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> in response');
  return m[1];
}

async function getPwaScript() {
  const res = await worker.fetch(new Request('https://x/#t=correct-secret'), env, {});
  return extractScript(await res.text());
}

describe('reconnectBackoffMs', () => {
  it('doubles each attempt starting at 1000ms', () => {
    expect(reconnectBackoffMs(0)).toBe(1000);
    expect(reconnectBackoffMs(1)).toBe(2000);
    expect(reconnectBackoffMs(2)).toBe(4000);
    expect(reconnectBackoffMs(3)).toBe(8000);
    expect(reconnectBackoffMs(4)).toBe(16000);
  });

  it('caps at 30_000 by default and never exceeds it, however high the attempt count climbs', () => {
    expect(reconnectBackoffMs(5)).toBe(30000);
    expect(reconnectBackoffMs(20)).toBe(30000);
    expect(reconnectBackoffMs(1000)).toBe(30000);
  });

  it('cap is overridable (not a hardcoded 30_000 baked into the formula)', () => {
    expect(reconnectBackoffMs(10, 5000)).toBe(5000);
  });
});

describe('createSeenIdGate', () => {
  it('renders a fresh id, rejects the same id again', () => {
    const gate = createSeenIdGate(400);
    expect(gate.shouldRender(1)).toBe(true);
    expect(gate.shouldRender(1)).toBe(false);
  });

  it('different ids are independent', () => {
    const gate = createSeenIdGate(400);
    expect(gate.shouldRender(1)).toBe(true);
    expect(gate.shouldRender(2)).toBe(true);
    expect(gate.shouldRender(1)).toBe(false);
    expect(gate.shouldRender(2)).toBe(false);
  });

  it('a genuine restart (unseen id lower than the tracked highest) resets the whole gate, so a legitimate new message reusing an old id number still renders', () => {
    const gate = createSeenIdGate(400);
    expect(gate.shouldRender(500)).toBe(true);
    expect(gate.shouldRender(501)).toBe(true);
    // DO restart: nextId reseeds lower (clock skew) and issues a brand-new,
    // never-before-seen id that happens to be less than 501 — must render,
    // not be swallowed by dedupe logic that only knows about the old epoch.
    expect(gate.shouldRender(10)).toBe(true);
    // The reset also means the OLD epoch's ids are forgotten — they'd only
    // ever legitimately reappear if the old epoch's own connection was still
    // alive, which a genuine restart rules out by definition.
    expect(gate.shouldRender(501)).toBe(true);
  });

  it('an ordinary duplicate of an already-tracked older id is still suppressed, not mistaken for a restart', () => {
    const gate = createSeenIdGate(400);
    expect(gate.shouldRender(1)).toBe(true);
    expect(gate.shouldRender(2)).toBe(true);
    expect(gate.shouldRender(3)).toBe(true);
    expect(gate.shouldRender(1)).toBe(false); // still inside the window — a real dup, not a restart
    expect(gate.shouldRender(2)).toBe(false);
  });

  it('bounded — the single oldest id is evicted once maxSize is exceeded', () => {
    const gate = createSeenIdGate(1);
    expect(gate.shouldRender(1)).toBe(true);
    expect(gate.shouldRender(2)).toBe(true); // id 2 evicts id 1 (maxSize 1)
    expect(gate.shouldRender(1)).toBe(true); // 1 was evicted — treated as fresh again
  });

  it('never unbounded — memory stays flat across a long monotonic run, and a duplicate still inside the window is still caught', () => {
    const gate = createSeenIdGate(50);
    for (let id = 0; id < 10_000; id++) gate.shouldRender(id);
    // A duplicate of the most recent id is still caught — bounded, not broken.
    expect(gate.shouldRender(9_999)).toBe(false);
    // An ancient, long-evicted id is unseen AND lower than the tracked
    // highest — indistinguishable from a genuine restart, so it wipes the
    // window (see createSeenIdGate's restart-defense comment) and renders.
    // Accepted tradeoff of the cheap restart defense, not a targeted
    // guarantee for this synthetic case.
    expect(gate.shouldRender(0)).toBe(true);
  });
});

describe('POST /client-error — reconnect_attempt beacon', () => {
  function post(url, body) {
    return worker.fetch(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }), env, {});
  }

  it('401 without a valid token, same as the existing client-error beacon', async () => {
    const res = await post('https://x/client-error', JSON.stringify({ kind: 'reconnect_attempt', trigger: 'watchdog' }));
    expect(res.status).toBe(401);
  });

  it('200 on a valid reconnect_attempt payload, logs ev:reconnect_attempt with the given fields, bypassing the message-required check', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post('https://x/client-error?t=correct-secret', JSON.stringify({
      kind: 'reconnect_attempt',
      trigger: 'watchdog',
      attempt: 2,
      backoffMs: 4000,
      readyState: 0,
      ts: 1700000000000,
    }));
    expect(res.status).toBe(200);
    const events = logEvents(logSpy, 'reconnect_attempt');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ trigger: 'watchdog', attempt: 2, backoffMs: 4000, readyState: 0, ts: 1700000000000 });
    logSpy.mockRestore();
  });

  it('never echoes the token into the log line, same guarantee as the client_error beacon', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await post('https://x/client-error?t=correct-secret', JSON.stringify({ kind: 'reconnect_attempt', trigger: 'manual' }));
    const rawLine = logSpy.mock.calls.find((c) => c[0].includes('reconnect_attempt'))[0];
    expect(rawLine).not.toContain('t=correct-secret');
    logSpy.mockRestore();
  });

  it('413 on an oversized reconnect_attempt body, same size cap as client_error', async () => {
    const res = await post('https://x/client-error?t=correct-secret', JSON.stringify({
      kind: 'reconnect_attempt',
      trigger: 'x'.repeat(4096),
    }));
    expect(res.status).toBe(413);
  });

  it('a plain client_error payload (no kind) still works exactly as before', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post('https://x/client-error?t=correct-secret', JSON.stringify({ message: 'boom' }));
    expect(res.status).toBe(200);
    expect(logEvents(logSpy, 'client_error')).toHaveLength(1);
    logSpy.mockRestore();
  });
});

describe('PWA client script wiring (source-level — no DOM/EventSource harness for timer-driven behavior)', () => {
  it('shared reconnect guard timeout is 20s, not the old 5s, and every scheduled trigger shares one backoff curve', async () => {
    const script = await getPwaScript();
    expect(script).toContain('const REFRESH_GUARD_TIMEOUT_MS = 20_000;');
    expect(script).toContain('refreshConfirmTimer = setTimeout(clearRefreshPending, REFRESH_GUARD_TIMEOUT_MS);');
    expect(script).not.toContain('setTimeout(clearRefreshPending, 5000)');
  });

  it('onopen and onerror both clear the pending-refresh guard, not just onmessage', async () => {
    const script = await getPwaScript();
    const onopenBlock = script.slice(script.indexOf('socket.onopen = () => {'), script.indexOf('socket.onmessage = (e) => {'));
    expect(onopenBlock).toContain('if (pendingRefreshConfirm) clearRefreshPending();');
    const onerrorBlock = script.slice(script.indexOf('socket.onerror = () => {'));
    expect(onerrorBlock).toContain('if (pendingRefreshConfirm) clearRefreshPending();');
  });

  it('scheduleReconnect (onerror/CLOSED) and checkStaleAndReconnect (watchdog) both route through scheduleReconnectAttempt -> refreshReconnect, not a bare connect()', async () => {
    const script = await getPwaScript();
    expect(script).toContain("scheduleReconnectAttempt('onerror');");
    expect(script).toContain("scheduleReconnectAttempt(trigger || 'watchdog');");
    expect(script).toContain('reconnectTimer = setTimeout(() => refreshReconnect(), delay);');
    // The one place that must NOT exist anymore: watchdog calling connect() directly with no backoff/guard.
    expect(script).not.toMatch(/isClientStale\(lastActivityTs, Date\.now\(\), STALE_AFTER_MS\)\)\s*{\s*connect\(\);/);
  });

  it('checkStaleAndReconnect re-arms lastActivityTs at the moment it decides to reconnect, before scheduling', async () => {
    const script = await getPwaScript();
    const fnStart = script.indexOf('function checkStaleAndReconnect(trigger) {');
    const fnBody = script.slice(fnStart, script.indexOf('setInterval(() => {', fnStart));
    const armIdx = fnBody.indexOf('lastActivityTs = Date.now();');
    const scheduleIdx = fnBody.indexOf('scheduleReconnectAttempt(trigger');
    expect(armIdx).toBeGreaterThan(-1);
    expect(scheduleIdx).toBeGreaterThan(armIdx);
  });

  it('visibilitychange->visible resets reconnectAttempt before checking staleness, so recovery after backgrounding is never stuck at a climbed backoff', async () => {
    const script = await getPwaScript();
    // Anchored on the unique combination (there's an unrelated earlier
    // visibilitychange listener for TTS keepalive that also checks
    // document.visibilityState === 'visible', so anchor on requestWakeLock()
    // immediately followed by this block, which only the watchdog listener has.
    const idx = script.indexOf('requestWakeLock();\n      // The user is back');
    expect(idx, 'expected to find the watchdog visibilitychange block').toBeGreaterThan(-1);
    const block = script.slice(idx, script.indexOf("checkStaleAndReconnect('visibility');", idx) + 50);
    const resetIdx = block.indexOf('reconnectAttempt = 0;');
    const checkIdx = block.indexOf("checkStaleAndReconnect('visibility');");
    expect(resetIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(resetIdx);
  });

  it('every SSE signal (message/ping/status/mark) resets reconnectAttempt to 0, not just onopen', async () => {
    const script = await getPwaScript();
    const listenerNames = ["socket.onmessage = (e) => {", "'ping', () => {", "'status', (e) => {", "'mark', (e) => {"];
    for (const marker of listenerNames) {
      const idx = script.indexOf(marker);
      expect(idx, `expected to find handler: ${marker}`).toBeGreaterThan(-1);
      const nextBrace = script.indexOf('reconnectAttempt = 0;', idx);
      // Must appear reasonably close (within the same small handler body, not
      // some unrelated later occurrence) — bound the search window.
      expect(nextBrace - idx).toBeLessThan(400);
    }
  });

  it('every manual trigger (pull-to-refresh) and every scheduled trigger reports a reconnect_attempt beacon', async () => {
    const script = await getPwaScript();
    expect(script).toContain("reportReconnectAttempt('manual', reconnectAttempt, 0, es ? es.readyState : -1);");
    expect(script).toContain('reportReconnectAttempt(trigger, attemptNum, delay, es ? es.readyState : -1);');
    // The topbar refresh button was removed; pull-to-refresh is now the only manual call site.
    const manualCount = script.split("reportReconnectAttempt('manual', reconnectAttempt, 0, es ? es.readyState : -1);").length - 1;
    expect(manualCount).toBe(1);
  });
});

describe('client-side id dedupe via the real onmessage handler (vm-page-driver)', () => {
  it('the same message id delivered twice renders exactly one row', async () => {
    const script = await getPwaScript();
    const { feed, fire } = driveClientScriptSession(script);
    const frame = { id: 42, platform: 'tw', user: 'Alice', text: 'hi' };
    fire(frame);
    fire(frame); // duplicate delivery — e.g. Last-Event-ID replay racing a live broadcast
    const rows = feed.children.filter((c) => c.tagName === 'div' || c.className || (c.classList && c.classList.set.size));
    // addRow appends one element per rendered message; count top-level feed children.
    expect(feed.children.length).toBe(1);
  });

  it('two distinct ids both render', async () => {
    const script = await getPwaScript();
    const { feed, fire } = driveClientScriptSession(script);
    fire({ id: 43, platform: 'tw', user: 'Alice', text: 'hi' });
    fire({ id: 44, platform: 'tw', user: 'Bob', text: 'yo' });
    expect(feed.children.length).toBe(2);
  });
});

// H2 (ChatHub review of 2026-09-12, internal): pure decision function, mirrored
// server-side by sse_replay_result's own ringFloor/gap fields (src/worker.js
// handleEvents) so the log line and the client's gray row always agree.
describe('detectReplayGap', () => {
  it('no lastEventId (fresh connect, nothing to replay) — never a gap regardless of floor', () => {
    expect(detectReplayGap(null, null)).toBe(false);
    expect(detectReplayGap(null, 50)).toBe(false);
    expect(detectReplayGap(undefined, 50)).toBe(false);
  });

  it('null ringFloor (empty ring) with a lastEventId set — gap, nothing survived to prove otherwise', () => {
    expect(detectReplayGap(10, null)).toBe(true);
  });

  it('lastEventId below the floor — the client missed messages the ring already evicted', () => {
    expect(detectReplayGap(10, 50)).toBe(true);
  });

  it('lastEventId equal to the floor — anchored, not a gap: the last-seen row is still the oldest one held', () => {
    expect(detectReplayGap(50, 50)).toBe(false);
  });

  it('lastEventId above the floor — normal case, the ring covers the whole gap', () => {
    expect(detectReplayGap(60, 50)).toBe(false);
  });
});

// H2: the client-visible signal itself — a one-shot gray row on the first
// status frame after a reconnect that requested a replay, driven through the
// real captured 'status' listener (not buildRow/addRow called directly), so
// this exercises the same wiring a browser would.
describe('replay-gap gray row (vm-page-driver, real status listener)', () => {
  function seededScript(seedLastMsgId) {
    return getPwaScript().then((script) => driveClientScriptSession(script, {
      localStorage: seedLastMsgId ? { 'multichat-spoken': JSON.stringify({ lastMsgId: seedLastMsgId }) } : {},
    }));
  }

  it('gap: lastEventId below ringFloor inserts exactly one gray info row on the first status frame', async () => {
    const { feed, fireEvent, getConnectUrl } = await seededScript(100);
    expect(getConnectUrl()).toContain('lastEventId=100');
    const fired = fireEvent('status', { tw: null, yt: null, ringFloor: 150 });
    expect(fired).toBe(true); // proves the listener is actually wired, not silently skipped
    expect(feed.children.length).toBe(1);
    const row = feed.children[0];
    expect(row.className).toBe('msg info');
    expect(row.textContent).toBe('reconnected, some messages may be missing');
  });

  it('anchored: lastEventId equal to ringFloor inserts nothing', async () => {
    const { feed, fireEvent } = await seededScript(100);
    fireEvent('status', { tw: null, yt: null, ringFloor: 100 });
    expect(feed.children.length).toBe(0);
  });

  it('no lastEventId (fresh connect) inserts nothing, even if ringFloor looks gap-shaped', async () => {
    const { feed, fireEvent, getConnectUrl } = await seededScript(0);
    expect(getConnectUrl()).not.toContain('lastEventId');
    fireEvent('status', { tw: null, yt: null, ringFloor: 150 });
    expect(feed.children.length).toBe(0);
  });

  it('one-shot: a later status push (count change) after the gap already fired does not insert a second row', async () => {
    const { feed, fireEvent } = await seededScript(100);
    fireEvent('status', { tw: null, yt: null, ringFloor: 150 }); // gap — fires once
    expect(feed.children.length).toBe(1);
    fireEvent('status', { tw: null, yt: null, ringFloor: 150 }); // e.g. a viewer-count push minutes later
    expect(feed.children.length).toBe(1);
  });

  it('the gray row never enters the seen-id gate or lastMsgId — a subsequent real message with a lower id still renders', async () => {
    const { feed, fireEvent, fire } = await seededScript(100);
    fireEvent('status', { tw: null, yt: null, ringFloor: 150 });
    expect(feed.children.length).toBe(1);
    fire({ id: 5, platform: 'tw', user: 'Alice', text: 'hi' }); // lower than seeded lastMsgId 100
    expect(feed.children.length).toBe(2);
  });
});
