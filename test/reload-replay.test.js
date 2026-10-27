// PWA reload keeps the feed: the page persists a feed cursor {hi, ts}
// (highest rendered msg.id + when it last advanced) under 'multichat-feed',
// and a fresh page load whose cursor is under FEED_CURSOR_MAX_AGE_MS old asks
// the DO for the WHOLE ring (lastEventId=RING_REPLAY_EVENT_ID) while using the
// stored hi for the replay-gap decision. Older/missing cursor → connects
// exactly as a fresh install. Pure lib helpers first, then the real PWA
// script driven through vm-page-driver, then the edge fold + DO replay loop
// for the sentinel value itself.
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/worker.js';
import * as lib from '../src/lib.js';
import {
  readFeedCursor, createFeedCursor,
  FEED_CURSOR_KEY, FEED_CURSOR_MAX_AGE_MS, FEED_CURSOR_WRITE_MIN_MS, RING_REPLAY_EVENT_ID,
} from '../src/lib.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';
import { makeHub } from './helpers/makeHub.js';
import { logEvents } from './helpers/logEvents.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { MULTICHAT_VIEW_SECRET: 'correct-secret' };
const MIN = 60_000;

async function getPwaScript() {
  const res = await worker.fetch(new Request('https://x/#t=correct-secret'), env, {});
  const html = await res.text();
  return html.match(/<script>([\s\S]*?)<\/script>/)[1];
}

async function page(localStorage = {}, extra = {}) {
  const script = await getPwaScript();
  const buzzes = [];
  const s = driveClientScriptSession(script, {
    localStorage,
    vibrate: (p) => { buzzes.push(p); return true; },
    extraGlobals: { __vite_ssr_import_0__: lib },
    ...extra,
  });
  return { ...s, buzzes, cursor: () => JSON.parse(s.getStored(FEED_CURSOR_KEY)) };
}

const freshCursor = (hi, ageMs = 0) => ({ [FEED_CURSOR_KEY]: JSON.stringify({ hi, ts: Date.now() - ageMs }) });
const chat = (id, over = {}) => ({ id, platform: 'tw', user: 'Alice', login: 'alice', text: 'hi ' + id, ts: Date.now(), ...over });
const gold = (id, over = {}) => ({ id, platform: 'tw', user: 'Baller', login: 'baller', kind: 'cheer', amount: '500 bits', text: 'yo', twId: 'g' + id, ts: Date.now(), ...over });

describe('feed cursor constants', () => {
  it('key sits in the multichat-* namespace; 30-min expiry; 5-s write throttle; ring sentinel is 0', () => {
    expect(FEED_CURSOR_KEY).toBe('multichat-feed');
    expect(FEED_CURSOR_MAX_AGE_MS).toBe(30 * MIN);
    expect(FEED_CURSOR_WRITE_MIN_MS).toBe(5_000);
    expect(RING_REPLAY_EVENT_ID).toBe(0);
  });
});

describe('readFeedCursor(raw, now, maxAgeMs)', () => {
  const now = 1_800_000_000_000;
  const ok = (over = {}) => JSON.stringify({ hi: 123, ts: now - MIN, ...over });

  it('returns hi for a well-formed cursor under the age cap', () => {
    expect(readFeedCursor(ok(), now, 30 * MIN)).toBe(123);
    expect(readFeedCursor(ok({ ts: now }), now, 30 * MIN)).toBe(123);
    expect(readFeedCursor(ok({ ts: now - 30 * MIN + 1 }), now, 30 * MIN)).toBe(123);
  });

  it('null when missing, empty, or not JSON', () => {
    expect(readFeedCursor(null, now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(undefined, now, 30 * MIN)).toBeNull();
    expect(readFeedCursor('', now, 30 * MIN)).toBeNull();
    expect(readFeedCursor('{not json', now, 30 * MIN)).toBeNull();
    expect(readFeedCursor('"a string"', now, 30 * MIN)).toBeNull();
    expect(readFeedCursor('null', now, 30 * MIN)).toBeNull();
  });

  it('null when hi is absent, non-numeric, zero, negative, or non-finite', () => {
    expect(readFeedCursor(JSON.stringify({ ts: now }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ hi: '123' }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ hi: 0 }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ hi: -5 }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ hi: Infinity }), now, 30 * MIN)).toBeNull();
  });

  it('null when ts is absent or non-numeric (no timestamp = cannot age it = never trusted)', () => {
    expect(readFeedCursor(JSON.stringify({ hi: 123 }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ ts: 'yesterday' }), now, 30 * MIN)).toBeNull();
  });

  it('expires at exactly the age cap, and a future-dated ts past the cap is equally untrusted', () => {
    expect(readFeedCursor(ok({ ts: now - 30 * MIN }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ ts: now - 31 * MIN }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ ts: now - 24 * 60 * MIN }), now, 30 * MIN)).toBeNull();
    expect(readFeedCursor(ok({ ts: now + 31 * MIN }), now, 30 * MIN)).toBeNull();
  });
});

describe('createFeedCursor(minWriteMs) — throttled high-water tracker', () => {
  const t0 = 1_800_000_000_000;

  it('first note writes immediately; the payload is {hi, ts}', () => {
    const c = createFeedCursor(5_000);
    expect(JSON.parse(c.note(10, t0))).toEqual({ hi: 10, ts: t0 });
  });

  it('a second note inside the window is throttled (null) but tracked; flush then writes the latest hi with ITS note time', () => {
    const c = createFeedCursor(5_000);
    c.note(10, t0);
    expect(c.note(11, t0 + 100)).toBeNull();
    expect(c.note(12, t0 + 200)).toBeNull();
    expect(JSON.parse(c.flush(t0 + 300))).toEqual({ hi: 12, ts: t0 + 200 });
  });

  it('flush with nothing dirty is null (no gratuitous writes on pagehide)', () => {
    const c = createFeedCursor(5_000);
    expect(c.flush(t0)).toBeNull();
    c.note(10, t0);
    expect(c.flush(t0 + 1)).toBeNull();
  });

  it('once the window has elapsed a note writes again, and the throttle re-arms from that write', () => {
    const c = createFeedCursor(5_000);
    c.note(10, t0);
    expect(c.note(11, t0 + 4_999)).toBeNull();
    expect(JSON.parse(c.note(12, t0 + 5_000))).toEqual({ hi: 12, ts: t0 + 5_000 });
    expect(c.note(13, t0 + 5_001)).toBeNull();
  });

  it('a lower or equal id never moves hi, never dirties, never writes (replayed/duplicate rows cannot rewind the cursor)', () => {
    const c = createFeedCursor(5_000);
    c.note(10, t0);
    expect(c.note(10, t0 + 10_000)).toBeNull();
    expect(c.note(3, t0 + 10_000)).toBeNull();
    expect(c.flush(t0 + 10_000)).toBeNull();
  });

  it('non-numeric ids (sys rows carry none) are ignored', () => {
    const c = createFeedCursor(5_000);
    expect(c.note(undefined, t0)).toBeNull();
    expect(c.note(null, t0)).toBeNull();
    expect(c.note('7', t0)).toBeNull();
    expect(c.flush(t0)).toBeNull();
  });
});

describe('PWA page load with a stored feed cursor (vm-page-driver, real connect() + status listener)', () => {
  it('fresh cursor (<30 min): the first connect asks for the whole ring, not for ids above the stored hi', async () => {
    const { getConnectUrl } = await page(freshCursor(100, 5 * MIN));
    expect(getConnectUrl()).toContain('lastEventId=' + RING_REPLAY_EVENT_ID);
    expect(getConnectUrl()).not.toContain('lastEventId=100');
  });

  it('stored hi at or above ringFloor replays silently — no gray row', async () => {
    for (const ringFloor of [100, 90]) {
      const { feed, fireEvent } = await page(freshCursor(100));
      expect(fireEvent('status', { tw: null, yt: null, ringFloor })).toBe(true);
      expect(feed.children.length).toBe(0);
    }
  });

  it('stored hi below ringFloor inserts exactly one gray "may be missing" row, once', async () => {
    const { feed, fireEvent } = await page(freshCursor(100));
    fireEvent('status', { tw: null, yt: null, ringFloor: 150 });
    expect(feed.children.length).toBe(1);
    expect(feed.children[0].className).toBe('msg info');
    expect(feed.children[0].textContent).toBe('reconnected, some messages may be missing');
    fireEvent('status', { tw: null, yt: null, ringFloor: 150 });
    expect(feed.children.length).toBe(1);
  });

  it('ring empty (DO restarted inside the window): the stored hi is gone from the ring → gray row', async () => {
    const { feed, fireEvent } = await page(freshCursor(100));
    fireEvent('status', { tw: null, yt: null, ringFloor: null });
    expect(feed.children.length).toBe(1);
    expect(feed.children[0].textContent).toBe('reconnected, some messages may be missing');
  });

  it('stale cursor (>=30 min since the last rendered message): connects clean and never inserts a gray row', async () => {
    const { feed, fireEvent, getConnectUrl } = await page(freshCursor(100, 30 * MIN));
    expect(getConnectUrl()).not.toContain('lastEventId');
    fireEvent('status', { tw: null, yt: null, ringFloor: 150 });
    fireEvent('status', { tw: null, yt: null, ringFloor: null });
    expect(feed.children.length).toBe(0);
  });

  it('no cursor / corrupt cursor: fresh-install behavior (no lastEventId, no gray row)', async () => {
    for (const ls of [{}, { [FEED_CURSOR_KEY]: '{oops' }, { [FEED_CURSOR_KEY]: JSON.stringify({ hi: 100 }) }]) {
      const { feed, fireEvent, getConnectUrl } = await page(ls);
      expect(getConnectUrl()).not.toContain('lastEventId');
      fireEvent('status', { tw: null, yt: null, ringFloor: 150 });
      expect(feed.children.length).toBe(0);
    }
  });

  it("a legacy multichat-spoken.lastMsgId alone no longer drives a replay (it had no age gate and produced a gray row on every next-day open)", async () => {
    const { feed, fireEvent, getConnectUrl } = await page({ 'multichat-spoken': JSON.stringify({ floor: 5, lastMsgId: 100, ids: [] }) });
    expect(getConnectUrl()).not.toContain('lastEventId');
    fireEvent('status', { tw: null, yt: null, ringFloor: null });
    expect(feed.children.length).toBe(0);
  });

  it('the ring request is one-shot: after the first status frame a reconnect uses the in-memory lastMsgId again', async () => {
    const s = await page(freshCursor(100));
    s.fireEvent('status', { tw: null, yt: null, ringFloor: 90 });
    s.fire(chat(120));
    expect(s.fireError()).toBe(true); // real onerror → scheduleReconnect → timer
    s.runTimers();                     // reconnect timer → refreshReconnect → /api/version fetch rejects → connect()
    await new Promise((r) => setTimeout(r, 0));
    const urls = s.getConnectUrls();
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain('lastEventId=120');
    expect(urls[1]).not.toContain('lastEventId=0');
  });

  it('with no cursor, an in-session reconnect still sends the in-memory lastMsgId (unchanged path)', async () => {
    const s = await page({});
    s.fire(chat(7));
    s.fireError();
    s.runTimers();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getConnectUrls().at(-1)).toContain('lastEventId=7');
  });
});

describe('PWA feed cursor persistence (vm-page-driver)', () => {
  it('the first rendered row writes {hi, ts} immediately; a second row inside the window is throttled, then a trailing timer flushes it', async () => {
    const s = await page({});
    expect(s.getStored(FEED_CURSOR_KEY)).toBeNull();
    const before = Date.now();
    s.fire(chat(7));
    const first = s.cursor();
    expect(first.hi).toBe(7);
    expect(first.ts).toBeGreaterThanOrEqual(before);
    expect(first.ts).toBeLessThanOrEqual(Date.now());
    const timersBefore = s.pendingTimerCount();
    s.fire(chat(8));
    expect(s.cursor().hi).toBe(7); // throttled — not a write per row
    expect(s.pendingTimerCount()).toBe(timersBefore + 1); // exactly one trailing flush armed
    s.fire(chat(9));
    expect(s.pendingTimerCount()).toBe(timersBefore + 1); // still one, not one per row
    s.runTimers();
    expect(s.cursor().hi).toBe(9);
  });

  it('pagehide flushes a dirty cursor', async () => {
    const s = await page({});
    s.fire(chat(7));
    s.fire(chat(8));
    expect(s.cursor().hi).toBe(7);
    expect(s.dispatchWindow('pagehide')).toBeGreaterThan(0);
    expect(s.cursor().hi).toBe(8);
  });

  it('visibilitychange → hidden flushes a dirty cursor', async () => {
    const s = await page({});
    s.fire(chat(7));
    s.fire(chat(8));
    s.setVisibility('hidden');
    expect(s.dispatchDocument('visibilitychange')).toBeGreaterThan(0);
    expect(s.cursor().hi).toBe(8);
  });

  it('sys rows (no id) and gated duplicates never touch the cursor', async () => {
    const s = await page({});
    s.fire({ sys: 'info', text: 'roomstate', ts: Date.now() });
    expect(s.getStored(FEED_CURSOR_KEY)).toBeNull();
    s.fire(chat(9));
    expect(s.cursor().hi).toBe(9);
    const timers = s.pendingTimerCount();
    s.fire(chat(9)); // duplicate delivery — seen-id gate drops it before addRow
    expect(s.pendingTimerCount()).toBe(timers);
    expect(s.cursor().hi).toBe(9);
  });

  it('multichat-spoken no longer carries lastMsgId (the cursor owns it); floor + ids are untouched', async () => {
    const s = await page({});
    s.fire(gold(10));
    const spoken = JSON.parse(s.getStored('multichat-spoken'));
    expect(spoken.floor).toBe(10);
    expect(Array.isArray(spoken.ids)).toBe(true);
    expect('lastMsgId' in spoken).toBe(false);
  });
});

describe('replayed rows and the shared buzz/TTS gate (no new gate — isEmittable already carries the age cap)', () => {
  it('a replayed gold row at/below the persisted floor never buzzes; one older than EMIT_TTL_MS never buzzes; a never-fired fresh one fires exactly once', async () => {
    const s = await page({
      ...freshCursor(60),
      'multichat-spoken': JSON.stringify({ floor: 50, ids: [] }),
    });
    s.fireEvent('status', { tw: null, yt: null, ringFloor: 10 });
    s.fire(gold(40));                                   // rendered before the reload, already fired then
    s.fire(gold(50));                                   // == floor
    expect(s.buzzes.length).toBe(0);
    s.fire(gold(70, { ts: Date.now() - lib.EMIT_TTL_MS - 1 })); // above floor but 30+ min old
    expect(s.buzzes.length).toBe(0);
    s.fire(gold(55));                                   // arrived while the page was dead, fresh → once
    expect(s.buzzes.length).toBe(1);
    s.fire(gold(55));
    expect(s.buzzes.length).toBe(1);
    expect(s.feed.children.filter((r) => r.className !== 'msg info').length).toBe(4);
  });
});

describe('full-ring replay fits the client seen-id gate', () => {
  it('SEEN_ID_MAX (PWA) >= RING_SIZE (DO), and 200 replayed ids render once each and dedupe on a second pass', async () => {
    const script = await getPwaScript();
    const seenMax = Number(script.match(/const SEEN_ID_MAX = (\d+)/)[1]);
    const ringSize = Number(readFileSync(path.join(REPO_ROOT, 'src', 'worker.js'), 'utf8').match(/^const RING_SIZE = (\d+);/m)[1]);
    expect(ringSize).toBe(200);
    expect(seenMax).toBe(400);
    expect(seenMax).toBeGreaterThanOrEqual(ringSize);
    const s = await page(freshCursor(1000));
    const base = 1_000_000;
    for (let i = 1; i <= ringSize; i++) s.fire(chat(base + i));
    expect(s.feed.children.length).toBe(ringSize);
    for (let i = 1; i <= ringSize; i++) s.fire(chat(base + i));
    expect(s.feed.children.length).toBe(ringSize);
  });
});

describe('edge fold + DO replay loop for the ring sentinel (pins the contract the PWA relies on)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('edge: ?lastEventId=0 is forwarded to the DO as Last-Event-ID: 0 (a "0" string is truthy and finite)', async () => {
    let captured = null;
    const e = {
      MULTICHAT_VIEW_SECRET: 'correct-secret',
      HUB: { getByName: () => ({ fetch: (_url, init) => { captured = init; return new Response('ok'); } }) },
    };
    const res = await worker.fetch(new Request('https://x/events?t=correct-secret&lastEventId=' + RING_REPLAY_EVENT_ID), e, {});
    expect(res.status).toBe(200);
    expect(captured.headers['Last-Event-ID']).toBe('0');
  });

  it('DO: Last-Event-ID: 0 replays every ring entry in order and logs sse_replay_result with lastId 0', () => {
    const { hub } = makeHub();
    hub.pushMessage('tw', { user: 'Alice', text: 'one' });
    hub.pushMessage('tw', { user: 'Bob', text: 'two' });
    hub.pushMessage('tw', { user: 'Cy', text: 'three' });
    const sent = [];
    hub.sendToController = (_c, m) => sent.push(m);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = hub.handleEvents(new Request('https://do/events', { headers: { 'Last-Event-ID': String(RING_REPLAY_EVENT_ID) } }));
    res.body.cancel();
    expect(sent.map((m) => m.text)).toEqual(['one', 'two', 'three']);
    const [line] = logEvents(spy, 'sse_replay_result');
    expect(line.lastId).toBe(0);
    expect(line.matched).toBe(3);
    expect(line.ringFloor).toBe(hub.ring[0].id);
    // FF 13: the sentinel is marked and never reports a gap (the client decides against its stored hi).
    expect(line.kind).toBe('ring');
    expect(line.gap).toBeNull();
  });

  it('DO: a real resume below the ring floor still logs gap true and carries no kind marker', () => {
    const { hub } = makeHub();
    hub.pushMessage('tw', { user: 'Alice', text: 'one' });
    hub.sendToController = () => {};
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = hub.handleEvents(new Request('https://do/events', { headers: { 'Last-Event-ID': String(RING_REPLAY_EVENT_ID + 1) } }));
    res.body.cancel();
    const [line] = logEvents(spy, 'sse_replay_result');
    expect(line.gap).toBe(true);
    expect(line).not.toHaveProperty('kind');
  });
});
