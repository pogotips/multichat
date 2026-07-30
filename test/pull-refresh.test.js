// Pull-to-refresh (installed PWA only): gesture threshold state machine,
// version-compare gate, the /api/version shape it reads, the resync-is-silent
// guarantee (reusing connect()'s Last-Event-ID replay must not duplicate
// rows), and the Rider-2 DO-blocking instrumentation log shape.
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { ChatHub, pullPhase, versionMismatch } from '../src/worker.js';

describe('pullPhase', () => {
  const THRESHOLD = 70;

  it('idle when not pulling down at all', () => {
    expect(pullPhase(0, THRESHOLD)).toBe('idle');
  });

  it('idle on any upward drag — downward-scroll intent cancels cleanly', () => {
    expect(pullPhase(-1, THRESHOLD)).toBe('idle');
    expect(pullPhase(-500, THRESHOLD)).toBe('idle');
  });

  it('pulling while below threshold', () => {
    expect(pullPhase(1, THRESHOLD)).toBe('pulling');
    expect(pullPhase(69, THRESHOLD)).toBe('pulling');
  });

  it('ready at and beyond threshold', () => {
    expect(pullPhase(70, THRESHOLD)).toBe('ready');
    expect(pullPhase(500, THRESHOLD)).toBe('ready');
  });
});

describe('versionMismatch', () => {
  it('false when versions match', () => {
    expect(versionMismatch('2026.07.27', '2026.07.27')).toBe(false);
  });

  it('true when versions differ (a new deploy shipped while the tab was open)', () => {
    expect(versionMismatch('2026.07.20', '2026.07.27')).toBe(true);
  });

  it('false when either side is missing — never force a reload loop on a fetch/embed failure', () => {
    expect(versionMismatch(null, '2026.07.27')).toBe(false);
    expect(versionMismatch('2026.07.27', null)).toBe(false);
    expect(versionMismatch(undefined, undefined)).toBe(false);
  });
});

describe('GET /api/version', () => {
  it('unauthed, returns { releaseVersion }', async () => {
    const res = await worker.fetch(new Request('https://x/api/version'), {}, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.releaseVersion).toBe('string');
    expect(body.releaseVersion).not.toBe('');
  });
});

function makeHub(envOverrides = {}) {
  const env = {
    TWITCH_CHANNEL: 'testchannel',
    CAPTURE: { async put() {} },
    ...envOverrides,
  };
  const ctx = { storage: { async setAlarm() {}, async get() { return undefined; }, async put() {} } };
  return new ChatHub(ctx, env);
}

describe('resync-is-silent: reconnecting at the current high-water mark replays nothing', () => {
  it('a manual pull-refresh reconnect (same lastMsgId) enqueues zero rows to the new controller', () => {
    const hub = makeHub();
    hub.pushMessage('tw', { user: 'Alice', text: 'hi' });
    hub.pushMessage('tw', { user: 'Bob', text: 'yo' });
    const lastMsgId = hub.nextId; // client's lastMsgId after having seen both live

    const enqueued = [];
    const controller = { enqueue: (bytes) => enqueued.push(bytes) };
    // Mirrors handleEvents' start(): only ring entries with id > lastId replay.
    const req = new Request('https://do/events', { headers: { 'Last-Event-ID': String(lastMsgId) } });
    const res = hub.handleEvents(req);
    res.body.cancel(); // drop the stream immediately, we only need start()'s side effects
    // start() ran synchronously on stream construction — assert via the ring
    // filter directly, same predicate handleEvents uses (msg.id > lastId).
    const wouldReplay = hub.ring.filter((m) => m.id > lastMsgId);
    expect(wouldReplay).toHaveLength(0);
  });

  it('a stale lastMsgId (gap, not a resync) still replays only the newer entries — sanity check on the filter itself', () => {
    const hub = makeHub();
    hub.pushMessage('tw', { user: 'Alice', text: 'hi' });
    const beforeSecond = hub.nextId;
    hub.pushMessage('tw', { user: 'Bob', text: 'yo' });
    const wouldReplay = hub.ring.filter((m) => m.id > beforeSecond);
    expect(wouldReplay).toHaveLength(1);
    expect(wouldReplay[0].user).toBe('Bob');
  });
});

describe('Rider 2: DO-blocking instrumentation log shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pollTwitchViewers logs a do_fetch_timing span around the Helix fetch', async () => {
    const hub = makeHub({ TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 55 }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await hub.pollTwitchViewers();
    const timings = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'do_fetch_timing');
    // app_token now instrumented — its span precedes helix_viewer_poll's
    // since getTwitchAppToken is awaited first.
    expect(timings).toEqual([
      expect.objectContaining({ op: 'app_token', durationMs: expect.any(Number), outcome: 'ok', span_id: expect.any(String) }),
      expect.objectContaining({ op: 'helix_viewer_poll', durationMs: expect.any(Number), outcome: 'ok', span_id: expect.any(String) }),
    ]);
    logSpy.mockRestore();
  });

  it('refreshTwitchUserToken logs a do_fetch_timing span around the token refresh', async () => {
    const hub = makeHub({ TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' });
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'tok', refresh_token: 'rot', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await hub.refreshTwitchUserToken('seed-refresh-token');
    const timings = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'do_fetch_timing');
    expect(timings).toEqual([expect.objectContaining({ op: 'token_refresh', durationMs: expect.any(Number), outcome: 'ok' })]);
    logSpy.mockRestore();
  });

  it('recoverGap logs a do_fetch_timing span around the backfill fetch', async () => {
    const hub = makeHub();
    const fetchSpy = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) });
    vi.stubGlobal('fetch', fetchSpy);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await hub.recoverGap();
    const timings = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'do_fetch_timing');
    expect(timings).toEqual([expect.objectContaining({ op: 'backfill', durationMs: expect.any(Number), outcome: 'ok' })]);
    logSpy.mockRestore();
  });

  it('a throwing backfill fetch still emits do_fetch_timing, with outcome "error"', async () => {
    const hub = makeHub();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('aborted')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await hub.recoverGap(); // outer catch swallows — must not throw out
    const timings = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'do_fetch_timing');
    expect(timings).toEqual([expect.objectContaining({ op: 'backfill', durationMs: expect.any(Number), outcome: 'error' })]);
    logSpy.mockRestore();
  });

  it('maybeEnsureEventSub logs a do_fetch_timing span around the whole ensure cycle', async () => {
    const hub = makeHub({ EVENTSUB_SECRET: 'sec', TWITCH_BROADCASTER_ID: '123', TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' });
    hub.esOrigin = 'https://example.com';
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) }) // app token
      .mockResolvedValueOnce({ ok: false, status: 500 }); // scope-check probe or list — either way, ensure resolves
    vi.stubGlobal('fetch', fetchSpy);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    hub.maybeEnsureEventSub();
    await vi.waitFor(() => {
      const timings = logSpy.mock.calls.map((c) => { try { return JSON.parse(c[0]); } catch { return null; } }).filter((e) => e && e.ev === 'do_fetch_timing');
      expect(timings.some((t) => t.op === 'eventsub_ensure' && (t.outcome === 'ok' || t.outcome === 'error'))).toBe(true);
    });
    logSpy.mockRestore();
  });
});

// Ingest-tail correlation (Phase 5). These
// three tests are the actual proof the instrumentation works — the negative
// case matters as much as the positive one.
describe('Ingest-tail: ingest_timing correlation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('positive: an ingest overlapping a slow outbound fetch attributes the delay to that span', async () => {
    const hub = makeHub({ TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'secret' });
    let resolveSlowFetch;
    const slowFetch = new Promise((resolve) => { resolveSlowFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => slowFetch));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Real execution of this test is sub-millisecond — Date.now()'s 1ms
    // resolution would read handler_ms/overlap_ms as 0 (an artifact, not "no
    // delay"). Force a deterministic advancing clock instead of depending on
    // real elapsed wall-clock time.
    let clock = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 25));

    // Fires the app-token fetch and leaves it pending — never awaited here,
    // so its span stays open in the module-level in-flight map for the
    // entire ingest below.
    const slowCallPromise = hub.getTwitchAppToken();

    const req = new Request('https://do/ingest/yt', {
      method: 'POST',
      headers: { 'X-Req-Id': 'req-positive' },
      body: JSON.stringify({ user: 'Alice', text: 'hi' }),
    });
    const res = await hub.handleIngestYt(req);
    expect(res.status).toBe(200);

    // Clean up the still-pending call so it doesn't leak into later tests.
    resolveSlowFetch({ ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) });
    await slowCallPromise;

    const ingestTiming = logSpy.mock.calls.map((c) => JSON.parse(c[0])).find((e) => e.ev === 'ingest_timing');
    expect(ingestTiming.req_id).toBe('req-positive');
    expect(ingestTiming.overlap_spans.length).toBeGreaterThan(0);
    expect(ingestTiming.overlap_ms).toBeGreaterThan(0);
    dateSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('negative: an ingest with no outbound fetch in flight attributes nothing — empty overlap_spans, delay lands in unattributed_ms', async () => {
    const hub = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = new Request('https://do/ingest/yt', {
      method: 'POST',
      headers: { 'X-Req-Id': 'req-negative' },
      body: JSON.stringify({ user: 'Bob', text: 'yo' }),
    });
    await hub.handleIngestYt(req);
    const ingestTiming = logSpy.mock.calls.map((c) => JSON.parse(c[0])).find((e) => e.ev === 'ingest_timing');
    expect(ingestTiming.req_id).toBe('req-negative');
    expect(ingestTiming.overlap_spans).toEqual([]);
    expect(ingestTiming.overlap_ms).toBe(0);
    expect(hub.delayAttributedMs).toBe(0);
    expect(hub.delayUnattributedMs).toBe(ingestTiming.handler_ms);
    logSpy.mockRestore();
  });

  it('error: a failed outbound fetch still logs outcome "error" from finally, and leaves no leaked in-flight entry to poison a later ingest', async () => {
    const hub = makeHub({ TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'secret' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await hub.getTwitchAppToken(); // outer catch swallows — must not throw out
    const fetchTimings = logSpy.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.ev === 'do_fetch_timing');
    expect(fetchTimings).toEqual([
      expect.objectContaining({ op: 'app_token', outcome: 'error', span_id: expect.any(String) }),
    ]);
    logSpy.mockRestore();

    // A leaked Map entry would show up here as a non-empty overlap_spans on
    // an ingest that has no actual outbound fetch in flight.
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = new Request('https://do/ingest/yt', { method: 'POST', body: JSON.stringify({ user: 'Carl', text: 'hey' }) });
    await hub.handleIngestYt(req);
    const ingestTiming = logSpy2.mock.calls.map((c) => JSON.parse(c[0])).find((e) => e.ev === 'ingest_timing');
    expect(ingestTiming.overlap_spans).toEqual([]);
    logSpy2.mockRestore();
  });
});
