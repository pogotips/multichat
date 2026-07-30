import { describe, it, expect } from 'vitest';
import { ChatHub } from '../src/worker.js';
// Plain-value constants live in lib.js, not the entry module — see lib.js's
// header comment (workerd rejects a non-function/class entry-module export).
import { PENDING_MOD_TTL_MS, PENDING_MOD_MAX } from '../src/lib.js';

// Minimal DO harness, mirrors test/do-hardening.test.js's makeHub — ChatHub's
// constructor only stashes ctx/env, and none of the methods under test here
// touch storage or the real Twitch socket.
function makeHub() {
  const env = { TWITCH_CHANNEL: 'testchannel' };
  const ctx = { storage: { setAlarm: async () => {} } };
  return new ChatHub(ctx, env);
}

// Captures every SSE frame a fake controller receives, decoded back to
// {event?, data} so tests can assert on the 'mark' event payload without
// re-parsing the wire format by hand.
function attachRecorder(hub) {
  const frames = [];
  const controller = {
    enqueue(bytes) {
      const text = new TextDecoder().decode(bytes);
      const eventMatch = text.match(/^event: (.+)$/m);
      const dataMatch = text.match(/^data: (.+)$/m);
      frames.push({ event: eventMatch ? eventMatch[1] : 'message', data: dataMatch ? JSON.parse(dataMatch[1]) : null });
    },
  };
  hub.clients.add(controller);
  hub.clientMeta.set(controller, { sseId: 's1', openedAt: Date.now(), strikes: 0 });
  return frames;
}

// caller mirrors the edge's x-multichat-caller header (set from which ingest
// secret matched — see handleIngestYt in the edge fetch handler). Defaults to
// 'poller' so existing mod-action tests don't need to know about scoping
// unless they're specifically testing it.
function req(body, caller = 'poller') {
  return {
    json: async () => body,
    headers: { get: (name) => (name.toLowerCase() === 'x-multichat-caller' ? caller : null) },
  };
}

describe('markDeletedYt', () => {
  it('marks the matching yt ring entry by ytId, ignores others', () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-1' });
    hub.pushMessage('yt', { user: 'Bob', text: 'yo', ytId: 'yt-2' });
    hub.pushMessage('tw', { user: 'Carol', text: 'hey' }, { id: 'yt-1' }); // same string, different platform
    hub.markDeletedYt({ ytId: 'yt-1' });
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
    expect(hub.ring.find((e) => e.ytId === 'yt-2').deleted).toBeUndefined();
    expect(hub.ring.find((e) => e.platform === 'tw').deleted).toBeUndefined();
  });

  it('marks every yt ring entry from the matching authorId', () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'one', ytId: 'yt-1', authorId: 'auth-1' });
    hub.pushMessage('yt', { user: 'Alice', text: 'two', ytId: 'yt-2', authorId: 'auth-1' });
    hub.pushMessage('yt', { user: 'Bob', text: 'three', ytId: 'yt-3', authorId: 'auth-2' });
    hub.markDeletedYt({ authorId: 'auth-1' });
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
    expect(hub.ring.find((e) => e.ytId === 'yt-2').deleted).toBe(true);
    expect(hub.ring.find((e) => e.ytId === 'yt-3').deleted).toBeUndefined();
  });

  it('broadcasts a mark event with platform:"yt" for a ytId delete', () => {
    const hub = makeHub();
    const frames = attachRecorder(hub);
    hub.markDeletedYt({ ytId: 'yt-1' });
    const mark = frames.find((f) => f.event === 'mark');
    expect(mark.data).toEqual({ action: 'delete', targetId: 'yt-1', platform: 'yt' });
  });

  it('broadcasts a mark event with action:"author_delete" for an authorId delete', () => {
    const hub = makeHub();
    const frames = attachRecorder(hub);
    hub.markDeletedYt({ authorId: 'auth-1' });
    const mark = frames.find((f) => f.event === 'mark');
    expect(mark.data).toEqual({ action: 'author_delete', authorId: 'auth-1', platform: 'yt' });
  });
});

describe('applyYtDelete (mirrors applyClearmsg parity)', () => {
  it('names the author when the target is still in the ring', () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-1' });
    hub.applyYtDelete('yt-1');
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
    const infoRow = hub.ring[hub.ring.length - 1];
    expect(infoRow.sys).toBe('deleted');
    expect(infoRow.text).toBe("Alice's message deleted");
  });

  it('falls back to generic text when the target has scrolled out of the ring', () => {
    const hub = makeHub();
    hub.applyYtDelete('never-seen');
    const infoRow = hub.ring[hub.ring.length - 1];
    expect(infoRow.sys).toBe('deleted');
    expect(infoRow.text).toBe('a message was deleted');
  });
});

describe('applyYtAuthorDelete (mirrors applyClearchat ban/timeout parity)', () => {
  it('names the author and strikes every one of their rows when found', () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'one', ytId: 'yt-1', authorId: 'auth-1' });
    hub.pushMessage('yt', { user: 'Alice', text: 'two', ytId: 'yt-2', authorId: 'auth-1' });
    hub.applyYtAuthorDelete('auth-1');
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
    expect(hub.ring.find((e) => e.ytId === 'yt-2').deleted).toBe(true);
    const infoRow = hub.ring[hub.ring.length - 1];
    expect(infoRow.text).toBe("Alice's messages were removed");
  });

  it('falls back to generic text when the author has scrolled out of the ring', () => {
    const hub = makeHub();
    hub.applyYtAuthorDelete('never-seen-author');
    const infoRow = hub.ring[hub.ring.length - 1];
    expect(infoRow.text).toBe("A viewer's messages were removed");
  });
});

describe('handleIngestYt: {type:"mod"} dispatch', () => {
  it('action:"delete" applies applyYtDelete and never reaches normalizeYt', async () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-1' });
    const res = await hub.handleIngestYt(req({ type: 'mod', action: 'delete', ytId: 'yt-1' }));
    expect(res.status).toBe(200);
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
  });

  it('action:"delete" without ytId is rejected 400', async () => {
    const hub = makeHub();
    const res = await hub.handleIngestYt(req({ type: 'mod', action: 'delete' }));
    expect(res.status).toBe(400);
  });

  it('action:"author_delete" applies applyYtAuthorDelete', async () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-1', authorId: 'auth-1' });
    const res = await hub.handleIngestYt(req({ type: 'mod', action: 'author_delete', authorId: 'auth-1' }));
    expect(res.status).toBe(200);
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
  });

  it('action:"author_delete" without authorId is rejected 400', async () => {
    const hub = makeHub();
    const res = await hub.handleIngestYt(req({ type: 'mod', action: 'author_delete' }));
    expect(res.status).toBe(400);
  });

  it('the raid-queue caller is forbidden from mod actions (secret-scoping regression guard)', async () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-1' });
    const res = await hub.handleIngestYt(req({ type: 'mod', action: 'delete', ytId: 'yt-1' }, 'raidq'));
    expect(res.status).toBe(403);
    // Never applied — the ring entry must be untouched.
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBeUndefined();
  });

  it('a missing/unknown caller header is forbidden from mod actions (fail closed)', async () => {
    const hub = makeHub();
    const res = await hub.handleIngestYt(req({ type: 'mod', action: 'delete', ytId: 'yt-1' }, null));
    expect(res.status).toBe(403);
  });

  it('an unrecognized mod action is rejected 400', async () => {
    const hub = makeHub();
    const res = await hub.handleIngestYt(req({ type: 'mod', action: 'nonsense' }));
    expect(res.status).toBe(400);
  });

  it('a plain chat message still normalizes through normalizeYt as before (regression)', async () => {
    const hub = makeHub();
    const res = await hub.handleIngestYt(req({ user: 'Alice', text: 'hello world' }));
    expect(res.status).toBe(200);
    const row = hub.ring[hub.ring.length - 1];
    expect(row.user).toBe('Alice');
    expect(row.text).toBe('hello world');
    expect(row.emotes).toBeUndefined();
  });

  it('the raid-queue caller is unaffected for its normal (non-mod) chat POSTs', async () => {
    const hub = makeHub();
    const res = await hub.handleIngestYt(req({ user: 'RenewalBot', text: 'membership renewed' }, 'raidq'));
    expect(res.status).toBe(200);
    expect(hub.ring[hub.ring.length - 1].user).toBe('RenewalBot');
  });

  it('a chat message with valid emotes carries them through to the SSE row', async () => {
    const hub = makeHub();
    const res = await hub.handleIngestYt(req({
      user: 'Alice',
      text: 'gg :_smile:',
      emotes: [{ start: 3, end: 10, url: 'https://yt3.ggpht.com/abc.png', alt: ':_smile:' }],
    }));
    expect(res.status).toBe(200);
    const row = hub.ring[hub.ring.length - 1];
    expect(row.emotes).toEqual([{ start: 3, end: 10, url: 'https://yt3.ggpht.com/abc.png', alt: ':_smile:' }]);
  });
});

// The yt-poller's retry queue dispatches up to 4 POSTs concurrently
// (tools/yt-poller/retry-queue.mjs SEND_CONCURRENCY) with no cross-item
// network-arrival ordering guarantee, so a mod delete/author_delete can reach
// this DO before the chat message it targets. pendingYtDeletes/
// pendingAuthorDeletes (fed by applyYtDelete/applyYtAuthorDelete's not-found
// branch, drained by pushMessage's resolvePendingYtMod) exist to catch that
// exact race instead of silently losing the moderation action.
describe('pending mod-action buffer (delete-before-message race)', () => {
  it('a ytId delete that arrives first is applied the moment its message lands', () => {
    const hub = makeHub();
    hub.applyYtDelete('yt-late'); // races ahead: not yet in the ring
    expect(hub.pendingYtDeletes.has('yt-late')).toBe(true);
    const msg = hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-late' });
    expect(msg.deleted).toBe(true);
    expect(hub.pendingYtDeletes.has('yt-late')).toBe(false); // consumed, not left behind
  });

  it('an authorId author_delete that arrives first is applied the moment the message lands', () => {
    const hub = makeHub();
    hub.applyYtAuthorDelete('auth-late');
    expect(hub.pendingAuthorDeletes.has('auth-late')).toBe(true);
    const msg = hub.pushMessage('yt', { user: 'Bob', text: 'hi', ytId: 'yt-2', authorId: 'auth-late' });
    expect(msg.deleted).toBe(true);
    expect(hub.pendingAuthorDeletes.has('auth-late')).toBe(false);
  });

  it('broadcasts a live mark event for the late-arriving row too', () => {
    const hub = makeHub();
    const frames = attachRecorder(hub);
    hub.applyYtDelete('yt-late');
    frames.length = 0; // drop the frames from applyYtDelete's own info-row push
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-late' });
    const mark = frames.find((f) => f.event === 'mark');
    expect(mark.data).toEqual({ action: 'delete', targetId: 'yt-late', platform: 'yt' });
  });

  it('via handleIngestYt end-to-end: delete POST before the chat POST still strikes the row', async () => {
    const hub = makeHub();
    const delRes = await hub.handleIngestYt(req({ type: 'mod', action: 'delete', ytId: 'yt-race' }));
    expect(delRes.status).toBe(200);
    const chatRes = await hub.handleIngestYt(req({ user: 'Alice', text: 'hi', ytId: 'yt-race' }));
    expect(chatRes.status).toBe(200);
    expect(hub.ring.find((e) => e.ytId === 'yt-race').deleted).toBe(true);
  });

  it('an unrelated message is never affected by an in-flight pending delete', () => {
    const hub = makeHub();
    hub.applyYtDelete('yt-late');
    const msg = hub.pushMessage('yt', { user: 'Carol', text: 'unrelated', ytId: 'yt-other' });
    expect(msg.deleted).toBeUndefined();
  });

  it('a pending delete older than PENDING_MOD_TTL_MS is not applied (stale, silently dropped)', () => {
    const hub = makeHub();
    hub.applyYtDelete('yt-stale');
    hub.pendingYtDeletes.set('yt-stale', Date.now() - PENDING_MOD_TTL_MS - 1);
    const msg = hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-stale' });
    expect(msg.deleted).toBeUndefined();
    expect(hub.pendingYtDeletes.has('yt-stale')).toBe(false); // still consumed on read, just not applied
  });

  it('a pending delete just inside PENDING_MOD_TTL_MS is still applied', () => {
    const hub = makeHub();
    hub.applyYtDelete('yt-fresh');
    hub.pendingYtDeletes.set('yt-fresh', Date.now() - PENDING_MOD_TTL_MS + 1000);
    const msg = hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-fresh' });
    expect(msg.deleted).toBe(true);
  });

  it('bounds pendingYtDeletes at PENDING_MOD_MAX, evicting the oldest first', () => {
    const hub = makeHub();
    for (let i = 0; i < PENDING_MOD_MAX + 5; i++) hub.applyYtDelete(`yt-${i}`);
    expect(hub.pendingYtDeletes.size).toBe(PENDING_MOD_MAX);
    expect(hub.pendingYtDeletes.has('yt-0')).toBe(false); // evicted, oldest-inserted
    expect(hub.pendingYtDeletes.has(`yt-${PENDING_MOD_MAX + 4}`)).toBe(true); // most recent survives
  });

  it('bounds pendingAuthorDeletes at PENDING_MOD_MAX the same way', () => {
    const hub = makeHub();
    for (let i = 0; i < PENDING_MOD_MAX + 5; i++) hub.applyYtAuthorDelete(`auth-${i}`);
    expect(hub.pendingAuthorDeletes.size).toBe(PENDING_MOD_MAX);
    expect(hub.pendingAuthorDeletes.has('auth-0')).toBe(false);
  });

  it('regression: an on-time delete (message already in the ring) behaves exactly as before — no pending buffer touched', () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-1' });
    hub.applyYtDelete('yt-1');
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
    expect(hub.pendingYtDeletes.size).toBe(0);
  });

  it('regression: an on-time author_delete behaves exactly as before — no pending buffer touched', () => {
    const hub = makeHub();
    hub.pushMessage('yt', { user: 'Alice', text: 'hi', ytId: 'yt-1', authorId: 'auth-1' });
    hub.applyYtAuthorDelete('auth-1');
    expect(hub.ring.find((e) => e.ytId === 'yt-1').deleted).toBe(true);
    expect(hub.pendingAuthorDeletes.size).toBe(0);
  });
});
