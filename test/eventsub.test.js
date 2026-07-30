import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  verifySignature,
  isStale,
  mapEventToRow,
  buildDesiredSubs,
  handleEventSubCallback,
  ChatHub,
} from '../src/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const raw = readFileSync(path.join(__dirname, 'fixtures', 'eventsub', name), 'utf8');
  return JSON.parse(raw);
}

// Redemption and ad-break fixtures are genuine `twitch event trigger <type>
// -v <version>` output from twitch-cli 1.1.25 (see git history for the
// capture command), pretty-printed but otherwise untouched.
//
// Hype Train fixtures are v2 (TODO-live-capture): production rejected every
// v1 create with a 400 (found in a 2026-07-25 log audit) because Twitch sunset v1
// — the current EventSub subscription-types docs only document v2 request/
// response shapes. twitch-cli 1.1.25 still can't mock v2 ("Invalid version
// given. Valid version(s): 1"), so these three are transcribed verbatim from
// Twitch's own documented example payloads instead of CLI output — replace
// with a real captured production notification the first time one fires.
// v1/v2 share every field mapEventToRow reads (level/total/progress/goal),
// so no mapping changes were needed, only the requested version.
const FIXTURES = {
  'channel.channel_points_custom_reward_redemption.add': loadFixture('redemption-add.v1.json'),
  'channel.hype_train.begin': loadFixture('hype-train-begin.v2.json'),
  'channel.hype_train.progress': loadFixture('hype-train-progress.v2.json'),
  'channel.hype_train.end': loadFixture('hype-train-end.v2.json'),
  'channel.ad_break.begin': loadFixture('ad-break-begin.v1.json'),
};

// Independent reference HMAC (node:crypto, not the Web Crypto API worker.js
// itself uses) — this is what makes the verifySignature tests a real check,
// not a tautology against the same primitive under test.
function referenceSignature(secret, id, timestamp, rawBody) {
  const digest = createHmac('sha256', secret).update(`${id}${timestamp}${rawBody}`).digest('hex');
  return `sha256=${digest}`;
}

describe('verifySignature', () => {
  const secret = 'test-eventsub-secret-not-real';
  const id = 'abc-123';
  const timestamp = '2026-07-22T10:00:00.000000000Z';
  const rawBody = JSON.stringify({ subscription: { type: 'channel.ad_break.begin' }, event: {} });

  it('accepts a validly-signed message', async () => {
    const sig = referenceSignature(secret, id, timestamp, rawBody);
    await expect(verifySignature(secret, id, timestamp, rawBody, sig)).resolves.toBe(true);
  });

  it('rejects a tampered body even with the original signature', async () => {
    const sig = referenceSignature(secret, id, timestamp, rawBody);
    const tamperedBody = rawBody.replace('ad_break', 'ad_bReak');
    await expect(verifySignature(secret, id, timestamp, tamperedBody, sig)).resolves.toBe(false);
  });

  it('rejects a tampered id even with the original signature', async () => {
    const sig = referenceSignature(secret, id, timestamp, rawBody);
    await expect(verifySignature(secret, 'different-id', timestamp, rawBody, sig)).resolves.toBe(false);
  });

  it('rejects the correct message signed with the wrong secret', async () => {
    const sig = referenceSignature('wrong-secret', id, timestamp, rawBody);
    await expect(verifySignature(secret, id, timestamp, rawBody, sig)).resolves.toBe(false);
  });

  it('rejects a signature header missing the sha256= prefix', async () => {
    const digest = createHmac('sha256', secret).update(`${id}${timestamp}${rawBody}`).digest('hex');
    await expect(verifySignature(secret, id, timestamp, rawBody, digest)).resolves.toBe(false);
  });

  it('rejects a missing/empty signature header', async () => {
    await expect(verifySignature(secret, id, timestamp, rawBody, '')).resolves.toBe(false);
    await expect(verifySignature(secret, id, timestamp, rawBody, null)).resolves.toBe(false);
  });

  it('rejects when the secret itself is unset', async () => {
    const sig = referenceSignature(secret, id, timestamp, rawBody);
    await expect(verifySignature('', id, timestamp, rawBody, sig)).resolves.toBe(false);
    await expect(verifySignature(undefined, id, timestamp, rawBody, sig)).resolves.toBe(false);
  });
});

describe('isStale', () => {
  const maxAgeMs = 10 * 60_000;

  it('accepts a fresh timestamp', () => {
    const now = Date.parse('2026-07-22T10:05:00.000Z');
    expect(isStale('2026-07-22T10:04:50.000Z', now, maxAgeMs)).toBe(false);
  });

  it('rejects a timestamp older than maxAgeMs', () => {
    const now = Date.parse('2026-07-22T10:20:00.000Z');
    expect(isStale('2026-07-22T10:00:00.000Z', now, maxAgeMs)).toBe(true);
  });

  it('treats an unparseable timestamp as stale (fail closed)', () => {
    expect(isStale('not-a-date', Date.now(), maxAgeMs)).toBe(true);
    expect(isStale('', Date.now(), maxAgeMs)).toBe(true);
    expect(isStale(undefined, Date.now(), maxAgeMs)).toBe(true);
  });
});

describe('buildDesiredSubs', () => {
  it('builds the exact desired subscription set, with no raid entry', () => {
    const subs = buildDesiredSubs('123456');
    expect(subs.map((s) => s.type)).toEqual([
      'channel.channel_points_custom_reward_redemption.add',
      'channel.hype_train.begin',
      'channel.hype_train.progress',
      'channel.hype_train.end',
      'channel.ad_break.begin',
    ]);
    expect(subs.every((s) => s.condition.broadcaster_user_id === '123456')).toBe(true);
    expect(subs.some((s) => s.type === 'channel.raid')).toBe(false);
  });

  it('pins every hype_train subscription to v2 (see buildDesiredSubs comment)', () => {
    const subs = buildDesiredSubs('123456');
    const hype = subs.filter((s) => s.type.startsWith('channel.hype_train.'));
    expect(hype).toHaveLength(3);
    expect(hype.every((s) => s.version === '2')).toBe(true);
  });
});

// Security regression guard: catches the CLI (or us) silently drifting to a
// fixture shaped for a different version than what we actually subscribe to
// — exactly the class of bug that would green-light tests against the wrong
// wire shape while looking like full coverage.
describe('fixture/subscription version parity', () => {
  it('every committed fixture is pinned to the version buildDesiredSubs actually requests', () => {
    const desired = buildDesiredSubs('1');
    for (const [type, fixture] of Object.entries(FIXTURES)) {
      const want = desired.find((s) => s.type === type);
      expect(want, `no desired sub found for fixture type ${type}`).toBeTruthy();
      expect(fixture.subscription.version, `${type} fixture/version mismatch`).toBe(want.version);
    }
  });
});

describe('mapEventToRow', () => {
  it('maps a channel-point redemption to a silent, distinctly-styled sys row', () => {
    const { event } = FIXTURES['channel.channel_points_custom_reward_redemption.add'];
    const row = mapEventToRow('channel.channel_points_custom_reward_redemption.add', event);
    expect(row).toEqual({
      user: 'testFromUser',
      sys: 'redeem',
      rewardTitle: 'Test Reward from CLI',
      userInput: 'Test Input From CLI',
    });
  });

  it('button-only redemption (empty user_input) still yields a row, without a userInput field', () => {
    const { event } = FIXTURES['channel.channel_points_custom_reward_redemption.add'];
    const row = mapEventToRow('channel.channel_points_custom_reward_redemption.add', { ...event, user_input: '' });
    expect(row).toEqual({
      user: 'testFromUser',
      sys: 'redeem',
      rewardTitle: 'Test Reward from CLI',
    });
    expect(row.userInput).toBeUndefined();
  });

  it('ellipsizes rewardTitle beyond 64 chars', () => {
    const { event } = FIXTURES['channel.channel_points_custom_reward_redemption.add'];
    const longTitle = 'x'.repeat(80);
    const row = mapEventToRow('channel.channel_points_custom_reward_redemption.add', {
      ...event,
      reward: { ...event.reward, title: longTitle },
    });
    expect(row.rewardTitle).toHaveLength(64);
    expect(row.rewardTitle.endsWith('…')).toBe(true);
  });

  it('ellipsizes on code points, never mid-surrogate-pair, for astral characters (regression guard for the UTF-16-vs-code-point invariant — see docs/ARCHITECTURE.md §2c)', () => {
    const { event } = FIXTURES['channel.channel_points_custom_reward_redemption.add'];
    const longTitle = '😀'.repeat(70); // each 😀 is 2 UTF-16 code units, 1 code point
    const row = mapEventToRow('channel.channel_points_custom_reward_redemption.add', {
      ...event,
      reward: { ...event.reward, title: longTitle },
    });
    const codePoints = [...row.rewardTitle];
    expect(codePoints).toHaveLength(64); // 63 emoji code points + the ellipsis
    expect(codePoints[63]).toBe('…');
    expect(codePoints.slice(0, 63).join('')).toBe('😀'.repeat(63)); // every emoji intact, no lone surrogate
  });

  it('ellipsizes userInput beyond 200 chars', () => {
    const { event } = FIXTURES['channel.channel_points_custom_reward_redemption.add'];
    const longInput = 'y'.repeat(250);
    const row = mapEventToRow('channel.channel_points_custom_reward_redemption.add', {
      ...event,
      user_input: longInput,
    });
    expect(row.userInput).toHaveLength(200);
    expect(row.userInput.endsWith('…')).toBe(true);
  });

  it('maps hype_train.begin to a gray sys row with the level', () => {
    const { event } = FIXTURES['channel.hype_train.begin'];
    const row = mapEventToRow('channel.hype_train.begin', event);
    expect(row).toEqual({ sys: 'hype', text: `Hype Train started — level ${event.level}` });
  });

  it('maps hype_train.progress to a gray sys row with level/progress/goal', () => {
    const { event } = FIXTURES['channel.hype_train.progress'];
    const row = mapEventToRow('channel.hype_train.progress', event);
    expect(row).toEqual({
      sys: 'hype',
      text: `Hype Train level ${event.level} — ${event.progress}/${event.goal}`,
    });
  });

  it('maps hype_train.end to a gray sys row with level/total', () => {
    const { event } = FIXTURES['channel.hype_train.end'];
    const row = mapEventToRow('channel.hype_train.end', event);
    expect(row).toEqual({ sys: 'hype', text: `Hype Train ended — level ${event.level}, total ${event.total}` });
  });

  it('maps ad_break.begin to a gray sys row with duration', () => {
    const { event } = FIXTURES['channel.ad_break.begin'];
    const row = mapEventToRow('channel.ad_break.begin', event);
    expect(row).toEqual({ sys: 'ad', text: `Ad break — ${event.duration_seconds}s` });
  });

  it('marks a manual (non-automatic true) ad break distinctly', () => {
    const { event } = FIXTURES['channel.ad_break.begin'];
    const row = mapEventToRow('channel.ad_break.begin', { ...event, is_automatic: true });
    expect(row.text).toBe(`Ad break — ${event.duration_seconds}s (auto)`);
  });

  it('returns null for an unknown subscription type', () => {
    expect(mapEventToRow('channel.some_future_type', {})).toBeNull();
  });

  it('returns null for a missing/non-object event', () => {
    expect(mapEventToRow('channel.ad_break.begin', null)).toBeNull();
    expect(mapEventToRow('channel.ad_break.begin', undefined)).toBeNull();
  });
});

// ── handleEventSubCallback (edge handler) ──────────────────────────────────
// Minimal harness mirroring test/do-hardening.test.js's makeHub style: real
// Request objects, a mock env carrying only what the handler reads.
const EDGE_SECRET = 'test-edge-eventsub-secret';

function signedRequest({ id = 'msg-1', timestamp = new Date().toISOString(), messageType, body, secret = EDGE_SECRET }) {
  const rawBody = JSON.stringify(body);
  const sig = referenceSignature(secret, id, timestamp, rawBody);
  return new Request('https://multichat.example.com/eventsub/callback', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-signature': sig,
      'twitch-eventsub-message-type': messageType,
    },
    body: rawBody,
  });
}

function makeEdgeEnv(overrides = {}) {
  const huBFetchCalls = [];
  return {
    EVENTSUB_SECRET: EDGE_SECRET,
    HUB: {
      getByName: () => ({
        fetch: async (url, opts) => {
          huBFetchCalls.push({ url, opts });
          return new Response('ok', { status: 200 });
        },
      }),
    },
    _huBFetchCalls: huBFetchCalls,
    ...overrides,
  };
}

function makeCtx() {
  const waited = [];
  return { waitUntil: (p) => waited.push(p), _waited: waited };
}

describe('handleEventSubCallback', () => {
  it('answers the webhook_callback_verification challenge with a raw 200 text body', async () => {
    const req = signedRequest({
      messageType: 'webhook_callback_verification',
      body: { challenge: 'pogchamp-kappa-360noscope-vohiyo', subscription: { type: 'channel.ad_break.begin' } },
    });
    const res = await handleEventSubCallback(req, makeEdgeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pogchamp-kappa-360noscope-vohiyo');
  });

  it('rejects a request with a mismatched signature (403)', async () => {
    const req = signedRequest({
      messageType: 'webhook_callback_verification',
      body: { challenge: 'x' },
      secret: 'a-completely-different-secret',
    });
    const res = await handleEventSubCallback(req, makeEdgeEnv(), makeCtx());
    expect(res.status).toBe(403);
  });

  it('rejects a request missing a required header (403)', async () => {
    const rawBody = JSON.stringify({ challenge: 'x' });
    const req = new Request('https://multichat.example.com/eventsub/callback', {
      method: 'POST',
      headers: { 'twitch-eventsub-message-id': 'msg-1' }, // timestamp/signature/type all missing
      body: rawBody,
    });
    const res = await handleEventSubCallback(req, makeEdgeEnv(), makeCtx());
    expect(res.status).toBe(403);
  });

  it('rejects (403, never throws) when the signature is valid but the body is not JSON', async () => {
    const id = 'msg-badjson';
    const timestamp = new Date().toISOString();
    const rawBody = '{not valid json';
    const sig = referenceSignature(EDGE_SECRET, id, timestamp, rawBody);
    const req = new Request('https://multichat.example.com/eventsub/callback', {
      method: 'POST',
      headers: {
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-signature': sig,
        'twitch-eventsub-message-type': 'notification',
      },
      body: rawBody,
    });
    await expect(handleEventSubCallback(req, makeEdgeEnv(), makeCtx())).resolves.toMatchObject({ status: 403 });
  });

  it('rejects a stale notification (older than 10 minutes) with 403', async () => {
    const staleTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
    const req = signedRequest({
      timestamp: staleTimestamp,
      messageType: 'notification',
      body: { subscription: { type: 'channel.ad_break.begin' }, event: {} },
    });
    const res = await handleEventSubCallback(req, makeEdgeEnv(), makeCtx());
    expect(res.status).toBe(403);
  });

  it('rejects when EVENTSUB_SECRET is unset (structurally cannot verify)', async () => {
    const req = signedRequest({
      messageType: 'webhook_callback_verification',
      body: { challenge: 'x' },
    });
    const res = await handleEventSubCallback(req, makeEdgeEnv({ EVENTSUB_SECRET: undefined }), makeCtx());
    expect(res.status).toBe(403);
  });

  it('acks a revocation with 204 and logs loudly at the edge (the log itself is not deferred to the DO)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = signedRequest({
      messageType: 'revocation',
      body: { subscription: { type: 'channel.ad_break.begin', status: 'authorization_revoked' } },
    });
    const res = await handleEventSubCallback(req, makeEdgeEnv(), makeCtx());
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('eventsub_revoked'));
    spy.mockRestore();
  });

  it('forwards a revocation to the DO via ctx.waitUntil so it can fast-track its next reconcile (see ChatHub.handleEventSubRevoked)', async () => {
    const env = makeEdgeEnv();
    const ctx = makeCtx();
    const req = signedRequest({
      messageType: 'revocation',
      body: { subscription: { type: 'channel.ad_break.begin', status: 'authorization_revoked' } },
    });
    const res = await handleEventSubCallback(req, env, ctx);
    expect(res.status).toBe(204);
    expect(ctx._waited).toHaveLength(1);
    await ctx._waited[0];
    expect(env._huBFetchCalls).toHaveLength(1);
    expect(env._huBFetchCalls[0].url).toBe('https://do/eventsub-revoked');
  });

  it('forwards a notification to the DO via ctx.waitUntil, never reading a type/sub-type header for routing', async () => {
    const env = makeEdgeEnv();
    const ctx = makeCtx();
    const req = signedRequest({
      id: 'msg-fwd-1',
      messageType: 'notification',
      body: { subscription: { type: 'channel.ad_break.begin' }, event: { duration_seconds: 30 } },
    });
    const res = await handleEventSubCallback(req, env, ctx);
    expect(res.status).toBe(204);
    expect(ctx._waited).toHaveLength(1);
    await ctx._waited[0];
    expect(env._huBFetchCalls).toHaveLength(1);
    const forwarded = env._huBFetchCalls[0];
    expect(forwarded.opts.headers['x-es-id']).toBe('msg-fwd-1');
    // No x-es-type / x-es-sub-type header — signed-truth rule: the DO must
    // read subscription.type from the (HMAC-covered) forwarded body itself.
    expect(forwarded.opts.headers['x-es-type']).toBeUndefined();
    expect(forwarded.opts.headers['x-es-sub-type']).toBeUndefined();
  });

  it('unknown message types are acked and ignored (204)', async () => {
    const req = signedRequest({ messageType: 'something_future_twitch_adds', body: {} });
    const res = await handleEventSubCallback(req, makeEdgeEnv(), makeCtx());
    expect(res.status).toBe(204);
  });
});

// ── ChatHub.handleEventSub (DO internal route) ──────────────────────────────
function makeDoEnv(overrides = {}) {
  return { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', ...overrides };
}

function eventSubDoRequest(id, subscriptionType, event) {
  return new Request('https://do/eventsub', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-es-id': id },
    body: JSON.stringify({ subscription: { type: subscriptionType }, event }),
  });
}

describe('ChatHub.handleEventSub — dedupe security invariant', () => {
  it('a replayed message-id is dropped and NEVER re-mapped, even if the resent body claims a different subscription.type', async () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv());
    const spy = vi.spyOn(hub, 'pushMessage');

    const first = await hub.handleEventSub(
      eventSubDoRequest('dup-1', 'channel.ad_break.begin', { duration_seconds: 60, is_automatic: false })
    );
    expect(first.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(hub.ring).toHaveLength(1);

    // Same message-id, but the (untrusted, forged) body now claims a
    // different, real subscription type — must still be dropped at the
    // dedupe gate before mapEventToRow is ever consulted.
    const replay = await hub.handleEventSub(
      eventSubDoRequest('dup-1', 'channel.channel_points_custom_reward_redemption.add', {
        user_name: 'attacker', reward: { title: 'forged' }, user_input: '',
      })
    );
    expect(replay.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1); // still just the one — never re-mapped
    expect(hub.ring).toHaveLength(1);
  });

  it('ignores a forged x-es-type/x-es-sub-type header and routes strictly off the signed body (regression guard for the signed-truth rule)', async () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv());
    const spy = vi.spyOn(hub, 'pushMessage');
    const req = new Request('https://do/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-es-id': 'forged-hdr-1',
        // Bogus headers a bug (or an attacker who somehow reached this
        // internal route) might attach — must never influence routing.
        // Only the (HMAC-covered, already-verified) body's subscription.type
        // may. handleEventSub must read subType from the body, not a header.
        'x-es-type': 'channel.raid',
        'x-es-sub-type': 'channel.raid',
      },
      body: JSON.stringify({
        subscription: { type: 'channel.ad_break.begin' },
        event: { duration_seconds: 45, is_automatic: false },
      }),
    });
    const res = await hub.handleEventSub(req);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, pushed] = spy.mock.calls[0];
    expect(pushed.sys).toBe('ad'); // from the body's ad_break type, not the forged raid header
    expect(pushed.text).toContain('Ad break');
  });

  it('rejects (400, never throws) a malformed JSON body', async () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv());
    const req = new Request('https://do/eventsub', {
      method: 'POST',
      headers: { 'x-es-id': 'bad-1' },
      body: '{not valid json',
    });
    const res = await hub.handleEventSub(req);
    expect(res.status).toBe(400);
  });

  it('dedupe insertion happens before the await on req.json() — two near-simultaneous deliveries of the same id are still deduped (regression guard for a check-then-act race)', async () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv());
    const spy = vi.spyOn(hub, 'pushMessage');
    let resolveJson;
    const slowJsonPromise = new Promise((resolve) => { resolveJson = resolve; });
    const slowReq = {
      headers: new Headers({ 'x-es-id': 'race-1' }),
      json: () => slowJsonPromise,
    };
    const fastReq = eventSubDoRequest('race-1', 'channel.ad_break.begin', { duration_seconds: 30, is_automatic: false });

    const firstCallPromise = hub.handleEventSub(slowReq); // starts, then awaits req.json()
    await Promise.resolve(); // let the first call reach its await point
    const secondResult = await hub.handleEventSub(fastReq); // same id arrives while the first is still pending
    expect(secondResult.status).toBe(200);
    expect(spy).not.toHaveBeenCalled(); // the duplicate is dropped, never mapped

    resolveJson({ subscription: { type: 'channel.ad_break.begin' }, event: { duration_seconds: 30, is_automatic: false } });
    const firstResult = await firstCallPromise;
    expect(firstResult.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1); // only the original delivery ever renders
  });

  it('rejects (400) a request with no x-es-id header', async () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv());
    const req = new Request('https://do/eventsub', { method: 'POST', body: '{}' });
    const res = await hub.handleEventSub(req);
    expect(res.status).toBe(400);
  });

  it('only renders a hype_train.progress row on an actual level-up, per-contribution noise suppressed', async () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv());
    const spy = vi.spyOn(hub, 'pushMessage');

    await hub.handleEventSub(eventSubDoRequest('h-begin', 'channel.hype_train.begin', { level: 1 }));
    expect(spy).toHaveBeenCalledTimes(1);

    // Same level (1) — a contribution that didn't cross a level boundary.
    await hub.handleEventSub(eventSubDoRequest('h-prog-1', 'channel.hype_train.progress', { level: 1, progress: 400, goal: 1000 }));
    expect(spy).toHaveBeenCalledTimes(1); // suppressed, not re-rendered

    // Level-up to 2 — renders.
    await hub.handleEventSub(eventSubDoRequest('h-prog-2', 'channel.hype_train.progress', { level: 2, progress: 50, goal: 2000 }));
    expect(spy).toHaveBeenCalledTimes(2);

    await hub.handleEventSub(eventSubDoRequest('h-end', 'channel.hype_train.end', { level: 2, total: 2050 }));
    expect(spy).toHaveBeenCalledTimes(3);
    expect(hub.hypeLevel).toBe(0); // reset on end
  });
});

// ── ChatHub.ensureEventSubSubscriptions — status-branch + pending-grace ────
function fetchMock(existingSubs, calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url: String(url), method });
    if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET') {
      return new Response(JSON.stringify({ data: existingSubs, pagination: {} }), { status: 200 });
    }
    if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (String(url) === 'https://api.twitch.tv/helix/eventsub/subscriptions' && method === 'POST') {
      return new Response(JSON.stringify({ data: [{}] }), { status: 202 });
    }
    return new Response('unexpected', { status: 404 });
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatHub.ensureEventSubSubscriptions', () => {
  const origin = 'https://multichat.example.com';
  const callback = `${origin}/eventsub/callback`;

  it('lists WITHOUT a status filter (must see failed/revoked/pending subs, not just enabled)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([], calls)));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    const listCall = calls.find((c) => c.method === 'GET' && c.url.includes('/eventsub/subscriptions'));
    expect(listCall.url).not.toContain('status=');
  });

  it('leaves a webhook_callback_verification_pending sub alone within the 10min grace window (never duplicate-creates)', async () => {
    const recentPending = {
      id: 'pending-1',
      type: 'channel.ad_break.begin',
      version: '1',
      status: 'webhook_callback_verification_pending',
      created_at: new Date(Date.now() - 2 * 60_000).toISOString(), // 2 min old — inside grace
      condition: { broadcaster_user_id: '42' },
      transport: { callback },
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([recentPending], calls)));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('pending-1'))).toBe(false);
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    // Only the 4 OTHER desired subs get created (redemption.add + 3 hype
    // train) — ad_break.begin has a live match and must not be re-created.
    expect(createCalls).toHaveLength(4);
  });

  it('treats a pending sub older than the 10min grace window as dead: deletes then recreates', async () => {
    const stalePending = {
      id: 'pending-2',
      type: 'channel.ad_break.begin',
      version: '1',
      status: 'webhook_callback_verification_pending',
      created_at: new Date(Date.now() - 11 * 60_000).toISOString(), // 11 min old — past grace
      condition: { broadcaster_user_id: '42' },
      transport: { callback },
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([stalePending], calls)));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('pending-2'))).toBe(true);
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    expect(createCalls).toHaveLength(5); // ad_break recreated + the other 4
  });

  it('a dead sub (e.g. authorization_revoked) is logged loudly and delete+recreated', async () => {
    const dead = {
      id: 'dead-1',
      type: 'channel.ad_break.begin',
      version: '1',
      status: 'authorization_revoked',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      condition: { broadcaster_user_id: '42' },
      transport: { callback },
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([dead], calls)));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('dead-1'))).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_dead_sub'));
    errSpy.mockRestore();
  });

  it('does not create a replacement for a dead sub if deleting it fails (never risk two enabled subs of the same type)', async () => {
    const dead = {
      id: 'dead-2',
      type: 'channel.ad_break.begin',
      version: '1',
      status: 'authorization_revoked',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      condition: { broadcaster_user_id: '42' },
      transport: { callback },
    };
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ url: String(url), method });
      if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
      }
      if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET') {
        return new Response(JSON.stringify({ data: [dead], pagination: {} }), { status: 200 });
      }
      if (method === 'DELETE') return new Response('server error', { status: 500 }); // delete fails
      if (method === 'POST') return new Response(JSON.stringify({ data: [{}] }), { status: 202 });
      return new Response('unexpected', { status: 404 });
    };
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    // ad_break.begin's replacement is withheld since its delete failed; the
    // other 4 desired subs (no existing match at all) are created normally.
    expect(createCalls).toHaveLength(4);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_delete_failed'));
    expect(hub.esAllHealthy).toBe(false);
    errSpy.mockRestore();
  });

  it('does not create a replacement at the correct version if deleting the wrong-version sub fails', async () => {
    const wrongVersion = {
      id: 'wrong-version-2',
      type: 'channel.hype_train.begin',
      version: '1', // desired is pinned to v2 — see buildDesiredSubs
      status: 'enabled',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      condition: { broadcaster_user_id: '42' },
      transport: { callback },
    };
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ url: String(url), method });
      if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
      }
      if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET') {
        return new Response(JSON.stringify({ data: [wrongVersion], pagination: {} }), { status: 200 });
      }
      if (method === 'DELETE') return new Response('server error', { status: 500 }); // delete fails
      if (method === 'POST') return new Response(JSON.stringify({ data: [{}] }), { status: 202 });
      return new Response('unexpected', { status: 404 });
    };
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    expect(createCalls).toHaveLength(4); // hype_train.begin's replacement withheld; other 4 created
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_version_mismatch'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_delete_failed'));
    expect(hub.esAllHealthy).toBe(false);
    errSpy.mockRestore();
  });

  it('an enabled sub is left alone (no delete, no re-create), but esAllHealthy stays false while others are still missing', async () => {
    const enabled = {
      id: 'enabled-1',
      type: 'channel.ad_break.begin',
      status: 'enabled',
      version: '1',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      condition: { broadcaster_user_id: '42' },
      transport: { callback },
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([enabled], calls)));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('enabled-1'))).toBe(false);
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    expect(createCalls).toHaveLength(4); // only the other 4 desired subs
    expect(hub.esAllHealthy).toBe(false); // 4 of 5 desired subs still had to be created
  });

  it('every desired sub already enabled at the correct version -> esAllHealthy true, zero create/delete', async () => {
    const desired = buildDesiredSubs('42');
    const existing = desired.map((want, i) => ({
      id: `sub-${i}`,
      type: want.type,
      version: want.version,
      status: 'enabled',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      condition: want.condition,
      transport: { callback },
    }));
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock(existing, calls)));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'))).toBe(false);
    expect(hub.esAllHealthy).toBe(true);
  });

  it('a same-slot subscription pinned to the wrong version is deleted and recreated at the correct version (never left running alongside the new one)', async () => {
    const wrongVersion = {
      id: 'wrong-version-1',
      type: 'channel.hype_train.begin',
      version: '1', // desired is pinned to v2 — see buildDesiredSubs
      status: 'enabled',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      condition: { broadcaster_user_id: '42' },
      transport: { callback },
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([wrongVersion], calls)));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions(origin);
    // The wrong-version sub is deleted (not left orphaned/enabled alongside a
    // freshly-created v2 one — that would double-deliver every event).
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('wrong-version-1'))).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_version_mismatch'));
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    expect(createCalls).toHaveLength(5); // the recreated hype_train.begin + the other 4 desired subs
    expect(hub.esAllHealthy).toBe(false);
    errSpy.mockRestore();
  });

  it('a 409 on create is treated as benign, never fails the routine', async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ url: String(url), method });
      if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
      }
      if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET') {
        return new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 });
      }
      if (method === 'POST') return new Response('conflict', { status: 409 });
      return new Response('unexpected', { status: 404 });
    };
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await expect(hub.ensureEventSubSubscriptions(origin)).resolves.not.toThrow();
  });

  it('skips entirely on a non-https origin (local dev — no public callback reachable)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([], calls)));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    await hub.ensureEventSubSubscriptions('http://localhost:8787');
    expect(calls).toHaveLength(0);
  });

  it('no-ops when EVENTSUB_SECRET is unset (degrade-to-hidden, same shape as viewer/follower counts)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([], calls)));
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ TWITCH_BROADCASTER_ID: '42' })); // no EVENTSUB_SECRET
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls).toHaveLength(0);
  });
});

// ── ChatHub.maybeEnsureEventSub — adaptive cadence ──────────────────────────
describe('ChatHub.maybeEnsureEventSub — adaptive cadence', () => {
  it('retries hourly (not daily) while esAllHealthy is false — e.g. a late-placed EVENTSUB_SECRET activates within the hour', () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    hub.esOrigin = 'https://multichat.example.com';
    const ensureSpy = vi.spyOn(hub, 'ensureEventSubSubscriptions').mockResolvedValue();
    hub.esEnsured = true;
    hub.esAllHealthy = false;

    hub.esLastEnsured = Date.now() - 30 * 60_000; // 30 min ago — inside the 1h retry window
    hub.maybeEnsureEventSub();
    expect(ensureSpy).not.toHaveBeenCalled();

    hub.esLastEnsured = Date.now() - 61 * 60_000; // just past 1h
    hub.maybeEnsureEventSub();
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it('backs off to the full 24h cadence once esAllHealthy is true', () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }));
    hub.esOrigin = 'https://multichat.example.com';
    const ensureSpy = vi.spyOn(hub, 'ensureEventSubSubscriptions').mockResolvedValue();
    hub.esEnsured = true;
    hub.esAllHealthy = true;

    hub.esLastEnsured = Date.now() - 61 * 60_000; // past the 1h retry window, well under 24h
    hub.maybeEnsureEventSub();
    expect(ensureSpy).not.toHaveBeenCalled();

    hub.esLastEnsured = Date.now() - 25 * 60 * 60_000; // past 24h
    hub.maybeEnsureEventSub();
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });
});

// ── ChatHub.handleEventSubRevoked — revocation fast-track ───────────────────
describe('ChatHub.handleEventSubRevoked', () => {
  it('resets esAllHealthy/esLastEnsured so the next ensure tick runs immediately instead of waiting out the daily cadence', () => {
    const hub = new ChatHub({ storage: {} }, makeDoEnv());
    hub.esAllHealthy = true;
    hub.esLastEnsured = Date.now();
    const res = hub.handleEventSubRevoked();
    expect(res.status).toBe(200);
    expect(hub.esAllHealthy).toBe(false);
    expect(hub.esLastEnsured).toBe(0);
  });
});
