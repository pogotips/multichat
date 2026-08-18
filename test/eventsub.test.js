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
  gigantifyTextMatches,
} from '../src/worker.js';
import { GIGANTIFY_SUPPRESS_WINDOW_MS, PENDING_MOD_MAX } from '../src/lib.js';
import { makeEventSubHub, makeStorage } from './helpers/makeHub.js';
import { withFakeTimers } from './helpers/withFakeTimers.js';
import { logEvents } from './helpers/logEvents.js';

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
  'channel.bits.use': loadFixture('bits-use-gigantify.v1.json'),
  // Any one channel.moderate fixture exercises the version-parity check below
  // for the type — every moderate-*.v2.json fixture is pinned to the same
  // subscription version regardless of which action it carries.
  'channel.moderate': loadFixture('moderate-timeout.v2.json'),
};

// Loaded separately from FIXTURES — used only to prove the cheer-drop
// invariant (Task 4), never wired into fixture/subscription version parity.
const FIXTURES_CHEER = loadFixture('bits-use-cheer.v1.json');

// One fixture per channel.moderate `action` value this feature renders —
// transcribed from Twitch's documented v2 example payloads (see
// docs/ARCHITECTURE.md §3a), same TODO-live-capture caveat as the Hype Train
// v2 fixtures above (twitch-cli 1.1.25 can't mock channel.moderate v2 at all).
// Keyed by action, not subType (subType is always 'channel.moderate' — the
// FIXTURES dict above assumes a 1:1 type->fixture mapping this feature
// doesn't have, hence the separate structure, mirroring FIXTURES_CHEER).
const MODERATE_FIXTURES = {
  timeout: loadFixture('moderate-timeout.v2.json'),
  ban: loadFixture('moderate-ban.v2.json'),
  unban: loadFixture('moderate-unban.v2.json'),
  untimeout: loadFixture('moderate-untimeout.v2.json'),
  delete: loadFixture('moderate-delete.v2.json'),
  warn: loadFixture('moderate-warn.v2.json'),
  shared_chat_ban: loadFixture('moderate-shared-chat-ban.v2.json'),
  shared_chat_unban: loadFixture('moderate-shared-chat-unban.v2.json'),
  shared_chat_timeout: loadFixture('moderate-shared-chat-timeout.v2.json'),
  shared_chat_untimeout: loadFixture('moderate-shared-chat-untimeout.v2.json'),
  shared_chat_delete: loadFixture('moderate-shared-chat-delete.v2.json'),
};
const MODERATE_FIXTURE_BAN_MALFORMED = loadFixture('moderate-ban-malformed.v2.json');

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
      'channel.bits.use',
      'channel.moderate',
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

  it('includes channel.bits.use pinned to v1', () => {
    const subs = buildDesiredSubs('123456');
    const bitsUse = subs.find((s) => s.type === 'channel.bits.use');
    expect(bitsUse).toBeDefined();
    expect(bitsUse.version).toBe('1');
    expect(bitsUse.condition).toEqual({ broadcaster_user_id: '123456' });
    expect(subs).toHaveLength(7);
  });

  it('includes channel.moderate pinned to v2, with its own two-field condition (needs moderator_user_id, unlike every other desired sub)', () => {
    const subs = buildDesiredSubs('123456');
    const moderate = subs.find((s) => s.type === 'channel.moderate');
    expect(moderate).toBeDefined();
    expect(moderate.version).toBe('2');
    expect(moderate.condition).toEqual({ broadcaster_user_id: '123456', moderator_user_id: '123456' });
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
  it.each([
    {
      label: 'a channel-point redemption maps to a silent, distinctly-styled sys row',
      type: 'channel.channel_points_custom_reward_redemption.add',
      expected: () => ({
        user: 'testFromUser',
        sys: 'redeem',
        rewardTitle: 'Test Reward from CLI',
        userInput: 'Test Input From CLI',
      }),
    },
    {
      label: 'hype_train.begin maps to a gray sys row with the level',
      type: 'channel.hype_train.begin',
      expected: (event) => ({ sys: 'hype', text: `Hype Train started — level ${event.level}` }),
    },
    {
      label: 'hype_train.progress maps to a gray sys row with level/progress/goal',
      type: 'channel.hype_train.progress',
      expected: (event) => ({ sys: 'hype', text: `Hype Train level ${event.level} — ${event.progress}/${event.goal}` }),
    },
    {
      label: 'hype_train.end maps to a gray sys row with level/total',
      type: 'channel.hype_train.end',
      expected: (event) => ({ sys: 'hype', text: `Hype Train ended — level ${event.level}, total ${event.total}` }),
    },
    {
      label: 'ad_break.begin maps to a gray sys row with duration',
      type: 'channel.ad_break.begin',
      expected: (event) => ({ sys: 'ad', text: `Ad break — ${event.duration_seconds}s` }),
    },
    {
      label: 'a manual (non-automatic true) ad break maps distinctly',
      type: 'channel.ad_break.begin',
      mutate: (event) => ({ ...event, is_automatic: true }),
      expected: (event) => ({ sys: 'ad', text: `Ad break — ${event.duration_seconds}s (auto)` }),
    },
  ])('$label', ({ type, mutate, expected }) => {
    const { event: fixtureEvent } = FIXTURES[type];
    const event = mutate ? mutate(fixtureEvent) : fixtureEvent;
    const row = mapEventToRow(type, event);
    expect(row).toEqual(expected(fixtureEvent));
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

  it('returns null for an unknown subscription type', () => {
    expect(mapEventToRow('channel.some_future_type', {})).toBeNull();
  });

  it('returns null for a missing/non-object event', () => {
    expect(mapEventToRow('channel.ad_break.begin', null)).toBeNull();
    expect(mapEventToRow('channel.ad_break.begin', undefined)).toBeNull();
  });
});

// ── mapEventToRow: channel.moderate ─────────────────────────────────────────
// Rendered set is 11 of the ~30 possible `action` values: the core 6
// (timeout/ban/unban/untimeout/delete/warn) + the 5 shared_chat_* variants —
// un-deferred (not a follow-up) because IRC has no shared-chat-aware row to
// fall back to once applyClearchat/applyClearmsg suppress their own row for
// an owned action. Every other action returns null silently (expected/
// frequent — settings toggles, VIP/mod grants, raids, ...).
describe('mapEventToRow: channel.moderate', () => {
  // expires_at is mutated to "now + duration" per case — the committed
  // fixtures carry a fixed 2022 timestamp (Twitch's own doc example), which
  // would render as "0s" (clamped, see formatDuration) against the real
  // clock a test actually runs under.
  function withExpiresIn(event, action, seconds) {
    return { ...event, [action]: { ...event[action], expires_at: new Date(Date.now() + seconds * 1000).toISOString() } };
  }

  it.each([
    {
      action: 'timeout',
      buildEvent: (event) => withExpiresIn(event, 'timeout', 598), // rounds to 10m, not floors to 9m
      expected: 'quotrok timed out TwitchDev (10m)',
    },
    { action: 'ban', buildEvent: (e) => e, expected: 'quotrok banned TwitchDev' },
    { action: 'unban', buildEvent: (e) => e, expected: 'quotrok unbanned TwitchDev' },
    { action: 'untimeout', buildEvent: (e) => e, expected: 'quotrok removed timeout on TwitchDev' },
    { action: 'delete', buildEvent: (e) => e, expected: "quotrok deleted TwitchDev's message" },
    { action: 'warn', buildEvent: (e) => e, expected: 'quotrok warned TwitchDev' },
    {
      action: 'shared_chat_ban',
      buildEvent: (e) => e,
      expected: 'quotrok banned TwitchDev (shared chat: adflynn404)',
    },
    {
      action: 'shared_chat_unban',
      buildEvent: (e) => e,
      expected: 'quotrok unbanned TwitchDev (shared chat: adflynn404)',
    },
    {
      action: 'shared_chat_timeout',
      buildEvent: (event) => withExpiresIn(event, 'shared_chat_timeout', 30),
      expected: 'quotrok timed out TwitchDev (30s) (shared chat: adflynn404)',
    },
    {
      action: 'shared_chat_untimeout',
      buildEvent: (e) => e,
      expected: 'quotrok removed timeout on TwitchDev (shared chat: adflynn404)',
    },
    {
      action: 'shared_chat_delete',
      buildEvent: (e) => e,
      expected: "quotrok deleted TwitchDev's message (shared chat: adflynn404)",
    },
  ])('$action maps to an attributed gray sys:"modact" row', ({ action, buildEvent, expected }) => {
    const { event: fixtureEvent } = MODERATE_FIXTURES[action];
    const row = mapEventToRow('channel.moderate', buildEvent(fixtureEvent));
    expect(row).toEqual({ sys: 'modact', text: expected });
  });

  it('an unowned action (e.g. emoteonly, mod, raid, clear) returns null silently, no log call', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { event } = MODERATE_FIXTURES.ban;
    for (const action of ['emoteonly', 'mod', 'unmod', 'vip', 'unvip', 'raid', 'unraid', 'followers', 'slow', 'add_blocked_term']) {
      expect(mapEventToRow('channel.moderate', { ...event, action })).toBeNull();
    }
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('an owned action with a missing expected field (schema drift) returns null AND logs modact_unmapped loudly (mirrors bits_use_unmapped)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { event } = MODERATE_FIXTURE_BAN_MALFORMED; // ban sub-object is missing user_name
    const row = mapEventToRow('channel.moderate', event);
    expect(row).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('modact_unmapped'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"action":"ban"'));
    logSpy.mockRestore();
  });

  it('a timeout action with a missing/unparseable expires_at also logs modact_unmapped and returns null', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { event } = MODERATE_FIXTURES.timeout;
    const row = mapEventToRow('channel.moderate', { ...event, timeout: { ...event.timeout, expires_at: undefined } });
    expect(row).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('modact_unmapped'));
    logSpy.mockRestore();
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
    const timestamp = new Date().toISOString();
    const req = signedRequest({
      id: 'msg-fwd-1',
      timestamp,
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
    // x-es-ts carries the edge-verified envelope timestamp — same
    // HMAC-covered-input rationale as x-es-id (see handleEventSubCallback);
    // ChatHub.handleGigantifyDedupe reads it for candidate-timestamp
    // selection.
    expect(forwarded.opts.headers['x-es-ts']).toBe(timestamp);
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
function eventSubDoRequest(id, subscriptionType, event, { esTs } = {}) {
  return new Request('https://do/eventsub', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-es-id': id,
      ...(esTs ? { 'x-es-ts': esTs } : {}),
    },
    body: JSON.stringify({ subscription: { type: subscriptionType }, event }),
  });
}

describe('ChatHub.handleEventSub — dedupe security invariant', () => {
  it('a replayed message-id is dropped and NEVER re-mapped, even if the resent body claims a different subscription.type', async () => {
    const hub = makeEventSubHub();
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
    const hub = makeEventSubHub();
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
    const hub = makeEventSubHub();
    const req = new Request('https://do/eventsub', {
      method: 'POST',
      headers: { 'x-es-id': 'bad-1' },
      body: '{not valid json',
    });
    const res = await hub.handleEventSub(req);
    expect(res.status).toBe(400);
  });

  it('dedupe insertion happens before the await on req.json() — two near-simultaneous deliveries of the same id are still deduped (regression guard for a check-then-act race)', async () => {
    const hub = makeEventSubHub();
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
    const hub = makeEventSubHub();
    const req = new Request('https://do/eventsub', { method: 'POST', body: '{}' });
    const res = await hub.handleEventSub(req);
    expect(res.status).toBe(400);
  });

  it('only renders a hype_train.progress row on an actual level-up, per-contribution noise suppressed', async () => {
    const hub = makeEventSubHub();
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
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    await hub.ensureEventSubSubscriptions(origin);
    const listCall = calls.find((c) => c.method === 'GET' && c.url.includes('/eventsub/subscriptions'));
    expect(listCall.url).not.toContain('status=');
  });

  it.each([
    {
      label: 'leaves a webhook_callback_verification_pending sub alone within the 10min grace window (never duplicate-creates)',
      existingSubs: () => [{
        id: 'pending-1', type: 'channel.ad_break.begin', version: '1',
        status: 'webhook_callback_verification_pending',
        created_at: new Date(Date.now() - 2 * 60_000).toISOString(), // 2 min old — inside grace
        condition: { broadcaster_user_id: '42' }, transport: { callback },
      }],
      deleted: false,
      // Only the 6 OTHER desired subs get created (redemption.add + 3 hype
      // train + bits.use + channel.moderate) — ad_break.begin has a live
      // match and must not be re-created.
      createCount: 6,
    },
    {
      label: 'treats a pending sub older than the 10min grace window as dead: deletes then recreates',
      existingSubs: () => [{
        id: 'pending-2', type: 'channel.ad_break.begin', version: '1',
        status: 'webhook_callback_verification_pending',
        created_at: new Date(Date.now() - 11 * 60_000).toISOString(), // 11 min old — past grace
        condition: { broadcaster_user_id: '42' }, transport: { callback },
      }],
      deleted: true,
      createCount: 7, // ad_break recreated + the other 6
    },
    {
      label: 'a dead sub (e.g. authorization_revoked) is logged loudly and delete+recreated',
      existingSubs: () => [{
        id: 'dead-1', type: 'channel.ad_break.begin', version: '1', status: 'authorization_revoked',
        created_at: new Date(Date.now() - 60_000).toISOString(),
        condition: { broadcaster_user_id: '42' }, transport: { callback },
      }],
      deleted: true,
      errContains: 'eventsub_dead_sub',
    },
    {
      label: 'an enabled sub is left alone (no delete, no re-create), but esAllHealthy stays false while others are still missing',
      existingSubs: () => [{
        id: 'enabled-1', type: 'channel.ad_break.begin', status: 'enabled', version: '1',
        created_at: new Date(Date.now() - 60_000).toISOString(),
        condition: { broadcaster_user_id: '42' }, transport: { callback },
      }],
      deleted: false,
      createCount: 6, // only the other 6 desired subs
      esAllHealthy: false, // 6 of 7 desired subs still had to be created
    },
    {
      label: 'every desired sub already enabled at the correct version -> esAllHealthy true, zero create/delete',
      existingSubs: () => buildDesiredSubs('42').map((want, i) => ({
        id: `sub-${i}`, type: want.type, version: want.version, status: 'enabled',
        created_at: new Date(Date.now() - 60_000).toISOString(),
        condition: want.condition, transport: { callback },
      })),
      deleted: false,
      createCount: 0,
      esAllHealthy: true,
      esModerateHealthy: true, // channel.moderate is among the desired subs mapped as already-enabled here
    },
    {
      // The wrong-version sub is deleted (not left orphaned/enabled alongside
      // a freshly-created v2 one — that would double-deliver every event).
      label: 'a same-slot subscription pinned to the wrong version is deleted and recreated at the correct version (never left running alongside the new one)',
      existingSubs: () => [{
        id: 'wrong-version-1', type: 'channel.hype_train.begin', version: '1', // desired is pinned to v2
        status: 'enabled', created_at: new Date(Date.now() - 60_000).toISOString(),
        condition: { broadcaster_user_id: '42' }, transport: { callback },
      }],
      deleted: true,
      errContains: 'eventsub_version_mismatch',
      createCount: 7, // the recreated hype_train.begin + the other 6 desired subs
      esAllHealthy: false,
    },
  ])('$label', async ({ existingSubs, deleted, createCount, errContains, esAllHealthy, esModerateHealthy }) => {
    const calls = [];
    const errSpy = errContains ? vi.spyOn(console, 'error').mockImplementation(() => {}) : null;
    vi.stubGlobal('fetch', vi.fn(fetchMock(existingSubs(), calls)));
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(deleted);
    if (createCount !== undefined) {
      const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
      expect(createCalls).toHaveLength(createCount);
    }
    if (errContains) {
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(errContains));
      errSpy.mockRestore();
    }
    if (esAllHealthy !== undefined) expect(hub.esAllHealthy).toBe(esAllHealthy);
    if (esModerateHealthy !== undefined) expect(hub.esModerateHealthy).toBe(esModerateHealthy);
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
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    await hub.ensureEventSubSubscriptions(origin);
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    // ad_break.begin's replacement is withheld since its delete failed; the
    // other 6 desired subs (no existing match at all) are created normally.
    expect(createCalls).toHaveLength(6);
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
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    await hub.ensureEventSubSubscriptions(origin);
    const createCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/eventsub/subscriptions'));
    expect(createCalls).toHaveLength(6); // hype_train.begin's replacement withheld; other 6 created
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_version_mismatch'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_delete_failed'));
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
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    await expect(hub.ensureEventSubSubscriptions(origin)).resolves.not.toThrow();
  });

  it('a page fetch that fails mid-pagination makes the list incomplete: throws, logs eventsub_list_incomplete', async () => {
    let page = 0;
    const fetchImpl = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
      }
      if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET') {
        page += 1;
        if (page === 1) return new Response(JSON.stringify({ data: [], pagination: { cursor: 'abc' } }), { status: 200 });
        return new Response('rate limited', { status: 429 }); // page 2 fails
      }
      return new Response('unexpected', { status: 404 });
    };
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    const token = await hub.getTwitchAppToken();
    await expect(hub.listEventSubSubscriptions(token)).rejects.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_list_incomplete'));
    errSpy.mockRestore();
  });

  it('a malformed page (data not an array) also counts as incomplete: throws, logs eventsub_list_incomplete', async () => {
    const fetchImpl = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
      }
      if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET') {
        return new Response(JSON.stringify({ data: null }), { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    };
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    const token = await hub.getTwitchAppToken();
    await expect(hub.listEventSubSubscriptions(token)).rejects.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_list_incomplete'));
    errSpy.mockRestore();
  });

  it('INVARIANT: an incomplete list skips the ENTIRE reconcile pass — zero creates, zero deletes, even though a live enabled sub existed on the unfetched page', async () => {
    const callback = `${origin}/eventsub/callback`;
    let page = 0;
    const fetchImpl = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
      }
      if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET') {
        page += 1;
        if (page === 1) return new Response(JSON.stringify({ data: [], pagination: { cursor: 'abc' } }), { status: 200 });
        // Page 2 (never reached by the fixed code) would have every desired
        // sub enabled — proving this isn't "no subs exist," it's "the list
        // was cut short."
        const allEnabled = buildDesiredSubs('42').map((want, i) => ({
          id: `sub-${i}`, type: want.type, version: want.version, status: 'enabled',
          created_at: new Date(Date.now() - 60_000).toISOString(), condition: want.condition, transport: { callback },
        }));
        return new Response(JSON.stringify({ data: allEnabled, pagination: {} }), { status: 200 });
      }
      // Any create/delete attempt during an incomplete-list pass is itself
      // the failure this test guards against.
      if (method === 'POST' || method === 'DELETE') return new Response('should not be called', { status: 500 });
      return new Response('unexpected', { status: 404 });
    };
    // Make page 2 fail on the FIRST reconcile call, then succeed if ever
    // retried in this same test (it isn't — one call is enough to prove it).
    const failingFetchImpl = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      if (String(url).startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && method === 'GET' && page === 1) {
        page += 1;
        return new Response('server error', { status: 500 }); // page 2 fails
      }
      return fetchImpl(url, opts);
    };
    vi.stubGlobal('fetch', vi.fn(failingFetchImpl));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    await expect(hub.ensureEventSubSubscriptions(origin)).resolves.not.toThrow();
    const calls = vi.mocked(fetch).mock.calls
      .map(([url, opts]) => ({ url: String(url), method: opts?.method || 'GET' }))
      .filter((c) => c.url.includes('/eventsub/subscriptions')); // exclude the oauth2/token call
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_list_incomplete'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eventsub_list_failed'));
    // esAllHealthy is untouched by an incomplete pass — never forced true or
    // false off partial data.
    expect(hub.esAllHealthy).toBe(false); // its constructor default, unchanged
    errSpy.mockRestore();
  });

  it('skips entirely on a non-https origin (local dev — no public callback reachable)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([], calls)));
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
    await hub.ensureEventSubSubscriptions('http://localhost:8787');
    expect(calls).toHaveLength(0);
  });

  it('no-ops when EVENTSUB_SECRET is unset (degrade-to-hidden, same shape as viewer/follower counts)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([], calls)));
    const hub = makeEventSubHub({ TWITCH_BROADCASTER_ID: '42' }); // no EVENTSUB_SECRET
    await hub.ensureEventSubSubscriptions(origin);
    expect(calls).toHaveLength(0);
  });
});

// ── ChatHub.maybeEnsureEventSub — adaptive cadence ──────────────────────────
describe('ChatHub.maybeEnsureEventSub — adaptive cadence', () => {
  it('retries hourly (not daily) while esAllHealthy is false — e.g. a late-placed EVENTSUB_SECRET activates within the hour', () => {
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
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
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' });
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
    const hub = makeEventSubHub();
    hub.esAllHealthy = true;
    hub.esLastEnsured = Date.now();
    const res = hub.handleEventSubRevoked();
    expect(res.status).toBe(200);
    expect(hub.esAllHealthy).toBe(false);
    expect(hub.esLastEnsured).toBe(0);
  });
});

// ── mapEventToRow: channel.bits.use ─────────────────────────────────────────
// Gigantify an Emote / Message Effect / On-Screen Celebration (type:
// "power_up") and broadcaster-defined Custom Power-ups (type:
// "custom_power_up") all cost real bits and get identical gold treatment.
// Only type: "cheer" is dropped — IRC's own `bits` tag already owns cheer
// rows, so a gold row here would double it.
describe('mapEventToRow: channel.bits.use type branch', () => {
  it.each([
    {
      label: 'drops type:"cheer" — IRC bits tag remains the only cheer source',
      event: () => FIXTURES_CHEER.event,
      expectNull: true,
    },
    {
      label: 'does NOT drop type:"power_up"',
      event: () => ({
        type: 'power_up',
        power_up: { type: 'gigantify_an_emote', emote: { id: '1', name: 'X' } },
        bits: 1, user_name: 'x',
      }),
      expectNull: false,
    },
    {
      label: 'does NOT drop type:"custom_power_up" — amended: it gets gold treatment too',
      event: () => ({
        type: 'custom_power_up',
        custom_power_up: { title: 'Confetti', reward_id: 'abc' },
        power_up: null, bits: 100, user_name: 'X',
      }),
      expectNull: false,
    },
  ])('$label', ({ event, expectNull }) => {
    const row = mapEventToRow('channel.bits.use', event());
    if (expectNull) expect(row).toBeNull();
    else expect(row).not.toBeNull();
  });

  it('fails closed on a missing/malformed custom_power_up.title — mirrors the power_up branch, no generic fallback row', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const missingObject = mapEventToRow('channel.bits.use', {
      type: 'custom_power_up',
      custom_power_up: null,
      power_up: null, bits: 100, user_name: 'X',
    });
    expect(missingObject).toBeNull();

    const missingTitle = mapEventToRow('channel.bits.use', {
      type: 'custom_power_up',
      custom_power_up: { reward_id: 'abc' },
      power_up: null, bits: 100, user_name: 'X',
    });
    expect(missingTitle).toBeNull();

    const emptyTitle = mapEventToRow('channel.bits.use', {
      type: 'custom_power_up',
      custom_power_up: { title: '' },
      power_up: null, bits: 100, user_name: 'X',
    });
    expect(emptyTitle).toBeNull();

    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ev: 'bits_use_unmapped', branch: 'custom_power_up', type: 'custom_power_up' }));
    logSpy.mockRestore();
  });

  it('fails closed on an unrecognized power_up.type and logs bits_use_unmapped instead of silently dropping', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const row = mapEventToRow('channel.bits.use', {
      type: 'power_up',
      power_up: { type: 'some_future_power_up' },
      bits: 50, user_name: 'X',
    });

    expect(row).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      ev: 'bits_use_unmapped', branch: 'power_up', type: 'power_up', powerUpType: 'some_future_power_up',
    }));
    logSpy.mockRestore();
  });

  it('fails closed on an unrecognized event.type and logs bits_use_unmapped instead of silently dropping', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const row = mapEventToRow('channel.bits.use', {
      type: 'some_future_bits_use_type',
      bits: 50, user_name: 'X',
    });

    expect(row).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      ev: 'bits_use_unmapped', branch: 'unrecognized_type', type: 'some_future_bits_use_type',
    }));
    logSpy.mockRestore();
  });
});

describe('mapEventToRow: channel.bits.use power_up/custom_power_up rows', () => {
  it.each([
    {
      label: 'gigantify_an_emote maps to a gold row with the real bits amount and the emote id/name',
      event: () => FIXTURES['channel.bits.use'].event, // gigantify fixture, already wired in Task 3
      check: (row) => expect(row).toEqual({
        user: 'Cool_User',
        kind: 'power_up',
        amount: '500 bits',
        powerUpType: 'gigantify_an_emote',
        powerUpLabel: 'Gigantify an Emote',
        text: 'Gigantify an Emote',
        emote: { id: 'emotesv2_abc123', name: 'PogChamp' },
      }),
    },
    {
      label: 'message_effect maps with its own label',
      event: () => loadFixture('bits-use-message-effect.v1.json').event,
      check: (row) => {
        expect(row.powerUpType).toBe('message_effect');
        expect(row.powerUpLabel).toBe('Message Effect');
        expect(row.amount).toBe('200 bits');
      },
    },
    {
      label: 'celebration maps with its own label',
      event: () => loadFixture('bits-use-celebration.v1.json').event,
      check: (row) => {
        expect(row.powerUpType).toBe('celebration');
        expect(row.powerUpLabel).toBe('On-Screen Celebration');
        expect(row.amount).toBe('1000 bits');
      },
    },
    {
      label: 'custom_power_up maps using its broadcaster-defined title, ellipsized like reward titles',
      event: () => loadFixture('bits-use-custom-power-up.v1.json').event,
      check: (row) => {
        expect(row.powerUpType).toBe('custom_power_up');
        expect(row.powerUpLabel).toBe('Confetti Bomb');
        expect(row.amount).toBe('300 bits');
        expect(row.user).toBe('Fourth_User');
      },
    },
  ])('$label', ({ event, check }) => {
    const row = mapEventToRow('channel.bits.use', event());
    check(row);
  });

  it('gigantify_an_emote with missing power_up.emote falls back to a label-only row (no emote field) and logs', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const row = mapEventToRow('channel.bits.use', {
      type: 'power_up',
      power_up: { type: 'gigantify_an_emote', emote: null },
      bits: 500, user_name: 'Cool_User',
    });

    expect(row).toEqual({
      user: 'Cool_User',
      kind: 'power_up',
      amount: '500 bits',
      powerUpType: 'gigantify_an_emote',
      powerUpLabel: 'Gigantify an Emote',
      text: 'Gigantify an Emote',
    });
    expect(row.emote).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      ev: 'bits_use_gigantify_no_emote', branch: 'power_up', powerUpType: 'gigantify_an_emote',
    }));
    logSpy.mockRestore();
  });
});

describe('ChatHub.pushMessage: channel.bits.use power_up label reaches the ring', () => {
  it('a gigantify power_up notification broadcasts a row whose text is the power-up label', async () => {
    const hub = makeEventSubHub();
    const { event } = loadFixture('bits-use-gigantify.v1.json');

    const res = await hub.handleEventSub(eventSubDoRequest('gigantify-text-check-1', 'channel.bits.use', event));
    expect(res.status).toBe(200);
    expect(hub.ring.at(-1).text).toBe('Gigantify an Emote');
  });

  // KNOWN TRAP: pushMessage's field allowlist has silently dropped a
  // power_up field before (powerUpLabel) — this proves the new `emote`
  // field actually survives pushMessage into the ring, not just mapEventToRow.
  it('the gigantify emote id/name survives pushMessage into the ring', async () => {
    const hub = makeEventSubHub();
    const { event } = loadFixture('bits-use-gigantify.v1.json');

    const res = await hub.handleEventSub(eventSubDoRequest('gigantify-emote-check-1', 'channel.bits.use', event));
    expect(res.status).toBe(200);
    expect(hub.ring.at(-1).emote).toEqual({ id: 'emotesv2_abc123', name: 'PogChamp' });
  });

  it('a power_up notification with no emote (e.g. message_effect) reaches the ring without an emote field', async () => {
    const hub = makeEventSubHub();
    const { event } = loadFixture('bits-use-message-effect.v1.json');

    const res = await hub.handleEventSub(eventSubDoRequest('message-effect-no-emote-1', 'channel.bits.use', event));
    expect(res.status).toBe(200);
    expect(hub.ring.at(-1).emote).toBeUndefined();
  });
});

describe('mapEventToRow: channel.bits.use redelivery/dedupe proof', () => {
  it('a redelivered gigantify notification (same x-es-id) is deduped before mapping — only one row', async () => {
    const hub = makeEventSubHub();
    const spy = vi.spyOn(hub, 'pushMessage');
    const { event } = loadFixture('bits-use-gigantify.v1.json');

    const first = await hub.handleEventSub(eventSubDoRequest('gigantify-redelivery-1', 'channel.bits.use', event));
    expect(first.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(hub.ring).toHaveLength(1);

    const replay = await hub.handleEventSub(eventSubDoRequest('gigantify-redelivery-1', 'channel.bits.use', event));
    expect(replay.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1); // still just the one — the redelivery never reaches mapEventToRow
    expect(hub.ring).toHaveLength(1);
  });
});

// ── Gigantify double-display suppression ───────────────────────────────────
// See docs/ARCHITECTURE.md §3a and ChatHub.handleGigantifyDedupe /
// consumePendingGigantify. No id correlates a channel.bits.use
// gigantify_an_emote event to the plain IRC PRIVMSG it accompanies — the
// match is heuristic: same login + gigantifyTextMatches + a tight time
// window (GIGANTIFY_SUPPRESS_WINDOW_MS). Covers both arrival orders.
describe('gigantifyTextMatches', () => {
  it.each([
    { label: 'exact match', text: 'PogChamp', emoteName: 'PogChamp', expected: true },
    { label: 'emote as one token among others (real channel.chat.message shape, twitchdev/issues#1047)', text: 'PogChamp cohhStaring', emoteName: 'PogChamp', expected: true },
    { label: 'emote preceded by other text', text: 'hey chat PogChamp', emoteName: 'PogChamp', expected: true },
    { label: 'substring, not a whole token — must NOT match', text: 'PogChampion', emoteName: 'PogChamp', expected: false },
    { label: 'substring inside a longer emote name — must NOT match', text: 'KappaPride', emoteName: 'Kappa', expected: false },
    { label: 'case-sensitive — Twitch emote codes are exact', text: 'pogchamp', emoteName: 'PogChamp', expected: false },
    { label: 'unrelated text entirely', text: 'hello world', emoteName: 'PogChamp', expected: false },
    { label: 'empty text', text: '', emoteName: 'PogChamp', expected: false },
    { label: 'empty emote name', text: 'PogChamp', emoteName: '', expected: false },
    { label: 'non-string text', text: null, emoteName: 'PogChamp', expected: false },
  ])('$label', ({ text, emoteName, expected }) => {
    expect(gigantifyTextMatches(text, emoteName)).toBe(expected);
  });
});

describe('ChatHub gigantify double-display suppression', () => {
  // login: cool_user, power_up.emote.name: PogChamp, bits: 500 — see
  // test/fixtures/eventsub/bits-use-gigantify.v1.json.
  const GIGANTIFY_EVENT = FIXTURES['channel.bits.use'].event;
  const ircLine = (id, login, text) =>
    `@id=${id};display-name=${login} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #testchannel :${text}`;

  it('IRC-first: supersedes the matching ring entry, broadcasts mark:supersede, and the gold row still renders', async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-msg-1' });
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');

    const res = await hub.handleEventSub(eventSubDoRequest('gig-order-a-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(res.status).toBe(200);

    const plain = hub.ring.find((e) => e.twId === 'irc-msg-1');
    expect(plain.superseded).toBe(true);

    const gold = hub.ring.at(-1);
    expect(gold.kind).toBe('power_up'); // gold row unconditionally rendered — never gated on the match
    expect(gold.text).toBe('Gigantify an Emote');

    const markCall = broadcastSpy.mock.calls.find(([event]) => event === 'mark');
    expect(markCall[1]).toEqual({ action: 'supersede', targetId: 'irc-msg-1' });
  });

  it('IRC-first: logs gigantify_superseded with the match heuristic details (login, emote id/name, eventTs, window)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-msg-log-1' });

    await hub.handleEventSub(eventSubDoRequest('gig-order-log-1', 'channel.bits.use', GIGANTIFY_EVENT));

    const events = logEvents(logSpy, 'gigantify_superseded');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ev: 'gigantify_superseded',
      order: 'irc_first',
      login: 'cool_user',
      twId: 'irc-msg-log-1',
      emoteName: 'PogChamp',
      windowMs: GIGANTIFY_SUPPRESS_WINDOW_MS,
    });
    logSpy.mockRestore();
  });

  it('EventSub-first: buffers the pending gigantify, then push-then-supersedes the matching PRIVMSG on arrival; gold row already rendered', async () => {
    const hub = makeEventSubHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const res = await hub.handleEventSub(eventSubDoRequest('gig-order-b-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(res.status).toBe(200);
    expect(hub.ring).toHaveLength(1); // gold row only — PRIVMSG hasn't arrived yet
    expect(hub.pendingGigantifies).toHaveLength(1);

    hub.handleIrcData(ircLine('irc-msg-2', 'cool_user', 'PogChamp'));

    // Structural fix: the PRIVMSG always pushes normally first (unified with
    // the IRC-first order below) — it's briefly a real ring entry, not
    // dropped on arrival — then immediately superseded via the same
    // markSuperseded path.
    expect(hub.ring).toHaveLength(2); // gold + the now-superseded plain row
    const plain = hub.ring.find((e) => e.twId === 'irc-msg-2');
    expect(plain.superseded).toBe(true);
    expect(hub.recentTwitchIds.has('irc-msg-2')).toBe(true); // pushMessage's normal bookkeeping ran
    expect(hub.pendingGigantifies).toHaveLength(0); // consumed

    const markCall = broadcastSpy.mock.calls.find(([event]) => event === 'mark');
    expect(markCall[1]).toEqual({ action: 'supersede', targetId: 'irc-msg-2' });
  });

  it('EventSub-first: logs gigantify_superseded with order eventsub_first and the buffered match details', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeEventSubHub();
    await hub.handleEventSub(eventSubDoRequest('gig-order-log-2', 'channel.bits.use', GIGANTIFY_EVENT));
    hub.handleIrcData(ircLine('irc-msg-log-2', 'cool_user', 'PogChamp'));

    const events = logEvents(logSpy, 'gigantify_superseded');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ev: 'gigantify_superseded',
      order: 'eventsub_first',
      login: 'cool_user',
      twId: 'irc-msg-log-2',
      emoteName: 'PogChamp',
      windowMs: GIGANTIFY_SUPPRESS_WINDOW_MS,
    });
    expect(typeof events[0].pendingTs).toBe('number');
    logSpy.mockRestore();
  });

  it('non-matching text from the SAME login is never eaten, either order — a same-login unrelated message must survive', async () => {
    const hubA = makeEventSubHub(); // IRC-first
    hubA.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'hey chat, unrelated message' }, { id: 'irc-unrelated-1' });
    await hubA.handleEventSub(eventSubDoRequest('gig-nomatch-a-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(hubA.ring.find((e) => e.twId === 'irc-unrelated-1').superseded).toBeUndefined();

    const hubB = makeEventSubHub(); // EventSub-first
    await hubB.handleEventSub(eventSubDoRequest('gig-nomatch-b-1', 'channel.bits.use', GIGANTIFY_EVENT));
    hubB.handleIrcData(ircLine('irc-unrelated-2', 'cool_user', 'hey chat, unrelated message'));
    expect(hubB.ring).toHaveLength(2); // gold row + the unrelated PRIVMSG, both present
    expect(hubB.ring.find((e) => e.twId === 'irc-unrelated-2')).toBeTruthy();
  });

  it('a different login with the exact same emote text is never matched', async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Someone_Else', login: 'someone_else', text: 'PogChamp' }, { id: 'irc-diff-login-1' });
    await hub.handleEventSub(eventSubDoRequest('gig-diff-login-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(hub.ring.find((e) => e.twId === 'irc-diff-login-1').superseded).toBeUndefined();
  });

  it('window expiry — IRC-first: a ring entry older than GIGANTIFY_SUPPRESS_WINDOW_MS is not superseded', () => withFakeTimers(async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-stale-1' });
    vi.advanceTimersByTime(GIGANTIFY_SUPPRESS_WINDOW_MS + 1);

    await hub.handleEventSub(eventSubDoRequest('gig-expiry-a-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(hub.ring.find((e) => e.twId === 'irc-stale-1').superseded).toBeUndefined();
    expect(hub.pendingGigantifies).toHaveLength(1); // falls through to the pending buffer — no ring match found
  }));

  it('window expiry — EventSub-first: a pending gigantify older than GIGANTIFY_SUPPRESS_WINDOW_MS no longer suppresses its PRIVMSG', () => withFakeTimers(async () => {
    const hub = makeEventSubHub();
    await hub.handleEventSub(eventSubDoRequest('gig-expiry-b-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(hub.pendingGigantifies).toHaveLength(1);

    vi.advanceTimersByTime(GIGANTIFY_SUPPRESS_WINDOW_MS + 1);
    hub.handleIrcData(ircLine('irc-late-1', 'cool_user', 'PogChamp'));

    expect(hub.ring.find((e) => e.twId === 'irc-late-1')).toBeTruthy(); // pushed normally, not suppressed
    expect(hub.pendingGigantifies).toHaveLength(0); // stale entry pruned on this call
  }));

  it('redelivery: a redelivered gigantify (same x-es-id) never supersedes a second row and never double-buffers', async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-redeliv-1' });
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');

    await hub.handleEventSub(eventSubDoRequest('gig-redeliv-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(broadcastSpy.mock.calls.filter(([event]) => event === 'mark')).toHaveLength(1);
    expect(hub.ring).toHaveLength(2); // plain (now superseded) + gold

    await hub.handleEventSub(eventSubDoRequest('gig-redeliv-1', 'channel.bits.use', GIGANTIFY_EVENT)); // same x-es-id
    expect(broadcastSpy.mock.calls.filter(([event]) => event === 'mark')).toHaveLength(1); // still just the one
    expect(hub.ring).toHaveLength(2); // no second gold row
    expect(hub.pendingGigantifies).toHaveLength(0); // and no stray pending entry either
  });

  it('gold row renders even when no plain PRIVMSG ever matches — never gated on the dedupe outcome', async () => {
    const hub = makeEventSubHub();
    const res = await hub.handleEventSub(eventSubDoRequest('gig-goldonly-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(res.status).toBe(200);
    expect(hub.ring).toHaveLength(1);
    expect(hub.ring[0].kind).toBe('power_up');
    expect(hub.ring[0].amount).toBe('500 bits');
  });

  it('message_effect (a different power_up type) never triggers gigantify dedupe — no pending entry, no ring scan side effect', async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-msg-effect-1' });
    const { event } = loadFixture('bits-use-message-effect.v1.json');

    await hub.handleEventSub(eventSubDoRequest('gig-not-applicable-1', 'channel.bits.use', event));

    expect(hub.pendingGigantifies).toHaveLength(0);
    expect(hub.ring.find((e) => e.twId === 'irc-msg-effect-1').superseded).toBeUndefined();
  });

  // ── F1 regression: multi-candidate wrong-victim selection ─────────────────
  // See PR41_GIGANTIFY_REVIEW_2026-08-08.md finding F1 — the original
  // ring.find() picked the OLDEST same-login token match, which eats an
  // unrelated earlier message whenever a spam-then-gigantify sequence
  // ("Kappa … Kappa … *gigantifies Kappa*") puts more than one candidate in
  // the window. pickGigantifyCandidate now selects by proximity to the
  // EventSub envelope timestamp (x-es-ts) instead. twTs values below are a
  // synthetic Twitch-side clock, deliberately decoupled from the real
  // Date.now() the ring's own GIGANTIFY_SUPPRESS_WINDOW_MS check uses (both
  // pushes happen within the same test tick, well inside that window).
  const TW_CLOCK_BASE = 1_700_000_000_000;

  it('F1 regression, spam-BEFORE: an earlier same-login lookalike survives; the later real gigantify message is superseded', async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-spam-1', ts: TW_CLOCK_BASE });
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-real-1', ts: TW_CLOCK_BASE + 5000 });

    const esTs = new Date(TW_CLOCK_BASE + 5001).toISOString(); // close to the real (later) message
    await hub.handleEventSub(eventSubDoRequest('gig-f1-before-1', 'channel.bits.use', GIGANTIFY_EVENT, { esTs }));

    expect(hub.ring.find((e) => e.twId === 'irc-spam-1').superseded).toBeUndefined();
    expect(hub.ring.find((e) => e.twId === 'irc-real-1').superseded).toBe(true);
  });

  it('F1 regression, spam-AFTER: a later same-login lookalike survives; the earlier real gigantify message is superseded', async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-real-2', ts: TW_CLOCK_BASE });
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-spam-2', ts: TW_CLOCK_BASE + 5000 });

    const esTs = new Date(TW_CLOCK_BASE + 1).toISOString(); // close to the real (earlier) message
    await hub.handleEventSub(eventSubDoRequest('gig-f1-after-1', 'channel.bits.use', GIGANTIFY_EVENT, { esTs }));

    expect(hub.ring.find((e) => e.twId === 'irc-real-2').superseded).toBe(true);
    expect(hub.ring.find((e) => e.twId === 'irc-spam-2').superseded).toBeUndefined();
  });

  it('F1 regression: an id-tagged emote match wins over a same-text row lacking emote data, regardless of timestamp proximity', async () => {
    const hub = makeEventSubHub();
    // Text-only lookalike, no emotes tag — closer in time to the event but
    // must lose to the id match below.
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-text-only-1', ts: TW_CLOCK_BASE + 4900 });
    // Real gigantify PRIVMSG: carries the emotes tag with the gigantified id.
    hub.pushMessage(
      'tw',
      { user: 'Cool_User', login: 'cool_user', text: 'PogChamp', emotes: [{ id: 'emotesv2_abc123', start: 0, end: 7 }] },
      { id: 'irc-id-match-1', ts: TW_CLOCK_BASE }
    );

    const esTs = new Date(TW_CLOCK_BASE + 4901).toISOString(); // much closer to the text-only row
    await hub.handleEventSub(eventSubDoRequest('gig-f1-idmatch-1', 'channel.bits.use', GIGANTIFY_EVENT, { esTs }));

    expect(hub.ring.find((e) => e.twId === 'irc-text-only-1').superseded).toBeUndefined();
    expect(hub.ring.find((e) => e.twId === 'irc-id-match-1').superseded).toBe(true);
  });

  it('server-side replay (Last-Event-ID resume) carries superseded: true through to a reconnecting client', async () => {
    const hub = makeEventSubHub({ TWITCH_CHANNEL: 'testchannel' });
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-replay-1' });
    await hub.handleEventSub(eventSubDoRequest('gig-replay-1', 'channel.bits.use', GIGANTIFY_EVENT));

    const supersededRow = hub.ring.find((e) => e.twId === 'irc-replay-1');
    expect(supersededRow.superseded).toBe(true);

    const sseRes = hub.handleEvents(new Request('https://do/events', { headers: { 'Last-Event-ID': String(supersededRow.id - 1) } }));
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const frames = [];
    // status + the superseded plain row + the gold row — three enqueues,
    // one per read() (a default, non-byte ReadableStream never coalesces).
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      const dataMatch = text.match(/^data: (.+)$/m);
      frames.push(dataMatch ? JSON.parse(dataMatch[1]) : null);
    }
    await reader.cancel();

    const replayedPlain = frames.find((f) => f && f.twId === 'irc-replay-1');
    expect(replayedPlain).toBeTruthy();
    expect(replayedPlain.superseded).toBe(true);
  });

  it('pendingGigantifies is bounded to PENDING_MOD_MAX — oldest pending gigantify is evicted on overflow', async () => {
    const hub = makeEventSubHub();
    for (let i = 0; i < PENDING_MOD_MAX; i++) {
      await hub.handleEventSub(eventSubDoRequest(`gig-cap-${i}`, 'channel.bits.use', { ...GIGANTIFY_EVENT, user_login: `user_${i}` }));
    }
    expect(hub.pendingGigantifies).toHaveLength(PENDING_MOD_MAX);
    expect(hub.pendingGigantifies[0].login).toBe('user_0');

    await hub.handleEventSub(eventSubDoRequest('gig-cap-overflow', 'channel.bits.use', { ...GIGANTIFY_EVENT, user_login: 'user_overflow' }));

    expect(hub.pendingGigantifies).toHaveLength(PENDING_MOD_MAX);
    expect(hub.pendingGigantifies[0].login).toBe('user_1'); // user_0 evicted, FIFO
    expect(hub.pendingGigantifies.at(-1).login).toBe('user_overflow');
  });

  it('gap recovery after EventSub-first suppression does NOT resurrect the superseded PRIVMSG (F2)', async () => {
    const hub = makeEventSubHub({ TWITCH_CHANNEL: 'testchannel' });
    const line = (id, sentTs, text) =>
      `@display-name=Cool_User;id=${id};tmi-sent-ts=${sentTs} :cool_user!cool_user@cool_user.tmi.twitch.tv PRIVMSG #testchannel :${text}`;

    await hub.handleEventSub(eventSubDoRequest('gig-gap-1', 'channel.bits.use', GIGANTIFY_EVENT));
    expect(hub.pendingGigantifies).toHaveLength(1);

    const sentTs = Date.now();
    const rawLine = line('irc-gap-1', sentTs, 'PogChamp');
    hub.handleIrcData(rawLine);

    const superseded = hub.ring.find((e) => e.twId === 'irc-gap-1');
    expect(superseded.superseded).toBe(true);
    // The structural fix (push-then-supersede) means the suppressed PRIVMSG
    // ran through pushMessage's normal bookkeeping exactly like any other —
    // both of recoverGap's independent guards (seenIds and the cutoffTs
    // watermark) now cover it.
    expect(hub.recentTwitchIds.has('irc-gap-1')).toBe(true);
    expect(hub.lastTwTmiSentTs).toBe(sentTs);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [rawLine] }) }));
    await hub.recoverGap();
    vi.unstubAllGlobals();

    expect(hub.ring.filter((e) => e.twId === 'irc-gap-1')).toHaveLength(1); // no resurrected second copy
    expect(hub.ring.find((e) => e.twId === 'irc-gap-1').superseded).toBe(true);
  });

  // ── PR41 fast-follow R1/R3 (2026-08-08): consumePendingGigantify now
  // applies the same two-tier gigantifyRowMatches rule selectGigantifyCandidates
  // already used for the IRC-first order. ─────────────────────────────────
  it('R3: power_up.emote.id missing — falls to the text tier, gold row still renders normally', async () => {
    const hub = makeEventSubHub();
    hub.pushMessage('tw', { user: 'Cool_User', login: 'cool_user', text: 'PogChamp' }, { id: 'irc-noid-1' });
    const noIdEvent = { ...GIGANTIFY_EVENT, power_up: { ...GIGANTIFY_EVENT.power_up, emote: { name: 'PogChamp' } } };

    const res = await hub.handleEventSub(eventSubDoRequest('gig-r3-noid-1', 'channel.bits.use', noIdEvent));
    expect(res.status).toBe(200);

    expect(hub.ring.find((e) => e.twId === 'irc-noid-1').superseded).toBe(true); // text-tier fallback still fires

    const gold = hub.ring.at(-1);
    expect(gold.kind).toBe('power_up');
    expect(gold.text).toBe('Gigantify an Emote');
  });

  it('R1 regression, EventSub-first: a same-login row with non-matching emote ids is NOT superseded by a coincidental text match; the row with the matching id IS', async () => {
    const hub = makeEventSubHub();
    const lineWithEmote = (id, emoteId, text) =>
      `@display-name=Cool_User;emotes=${emoteId}:0-${text.length - 1};id=${id} :cool_user!cool_user@cool_user.tmi.twitch.tv PRIVMSG #testchannel :${text}`;

    await hub.handleEventSub(eventSubDoRequest('gig-r1-1', 'channel.bits.use', GIGANTIFY_EVENT)); // buffers pending, emoteId emotesv2_abc123
    expect(hub.pendingGigantifies).toHaveLength(1);

    hub.handleIrcData(lineWithEmote('irc-wrongid-1', 'emotesv2_WRONG', 'PogChamp')); // text matches, id doesn't
    expect(hub.ring.find((e) => e.twId === 'irc-wrongid-1').superseded).toBeUndefined();
    expect(hub.pendingGigantifies).toHaveLength(1); // not consumed — still buffered

    hub.handleIrcData(lineWithEmote('irc-rightid-1', 'emotesv2_abc123', 'PogChamp')); // matching id
    expect(hub.ring.find((e) => e.twId === 'irc-rightid-1').superseded).toBe(true);
    expect(hub.pendingGigantifies).toHaveLength(0); // consumed
  });
});

describe('mapEventToRow: channel.moderate redelivery/dedupe proof', () => {
  it('a redelivered timeout notification (same x-es-id) is deduped before mapping — only one row', async () => {
    const hub = makeEventSubHub();
    const spy = vi.spyOn(hub, 'pushMessage');
    const { event } = MODERATE_FIXTURES.timeout;

    const first = await hub.handleEventSub(eventSubDoRequest('modact-redelivery-1', 'channel.moderate', event));
    expect(first.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(hub.ring).toHaveLength(1);

    const replay = await hub.handleEventSub(eventSubDoRequest('modact-redelivery-1', 'channel.moderate', event));
    expect(replay.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1); // still just the one — the redelivery never reaches mapEventToRow
    expect(hub.ring).toHaveLength(1);
  });
});

// ── ChatHub.logEventSubScopeCheck — bits:read + esScopeCheckResult ────────
// Bypasses the getTwitchUserToken refresh chain entirely by pre-seeding
// hub.twUserToken/twUserTokenExp with a live token (same shortcut
// test/live-counts.test.js uses) — only the oauth2/validate call itself is
// under test here, not the refresh chain (already covered elsewhere).
function stubValidate(scopes, calls = []) {
  return vi.fn(async (url, opts = {}) => {
    calls.push(String(url));
    expect(String(url)).toBe('https://id.twitch.tv/oauth2/validate');
    return new Response(JSON.stringify({ user_id: '42', scopes }), { status: 200 });
  });
}

function makeScopeCheckHub(envOverrides = {}) {
  const hub = makeEventSubHub({ TWITCH_BROADCASTER_ID: '42', ...envOverrides });
  hub.twUserToken = 'live-user-token';
  hub.twUserTokenExp = Date.now() + 60_000;
  return hub;
}

describe('ChatHub.logEventSubScopeCheck', () => {
  it('all 4 required scopes present -> hasBitsRead true, hasAllEventSubScopes true, stored on the instance', async () => {
    const scopes = ['channel:read:redemptions', 'channel:read:hype_train', 'channel:read:ads', 'bits:read'];
    vi.stubGlobal('fetch', stubValidate(scopes));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeScopeCheckHub();

    await hub.logEventSubScopeCheck();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasBitsRead":true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasAllEventSubScopes":true'));
    expect(hub.esScopeCheckResult).not.toBeNull();
    expect(hub.esScopeCheckResult.hasBitsRead).toBe(true);
    logSpy.mockRestore();
  });

  it('bits:read missing -> hasBitsRead false, hasAllEventSubScopes false, esScopeCheckResult.hasBitsRead false', async () => {
    const scopes = ['channel:read:redemptions', 'channel:read:hype_train', 'channel:read:ads'];
    vi.stubGlobal('fetch', stubValidate(scopes));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeScopeCheckHub();

    await hub.logEventSubScopeCheck();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasBitsRead":false'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasAllEventSubScopes":false'));
    expect(hub.esScopeCheckResult.hasBitsRead).toBe(false);
    logSpy.mockRestore();
  });

  it('a scope OTHER than bits:read is missing -> hasBitsRead true but hasAllEventSubScopes false (independent booleans)', async () => {
    const scopes = ['channel:read:redemptions', 'channel:read:ads', 'bits:read']; // channel:read:hype_train missing
    vi.stubGlobal('fetch', stubValidate(scopes));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeScopeCheckHub();

    await hub.logEventSubScopeCheck();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasBitsRead":true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasAllEventSubScopes":false'));
    expect(hub.esScopeCheckResult.hasBitsRead).toBe(true);
    expect(hub.esScopeCheckResult.hasAllEventSubScopes).toBe(false);
    logSpy.mockRestore();
  });

  it('esScopeCheckResult starts null on a fresh ChatHub instance', () => {
    const hub = makeScopeCheckHub();
    expect(hub.esScopeCheckResult).toBeNull();
  });

  // channel.moderate v2's 8 OR-groups are a distinct shape from the flat
  // 4-scope REQUIRED_EVENTSUB_SCOPES list above (each group satisfied by
  // either its read or manage variant) — covered independently here rather
  // than folded into the tests above.
  const ALL_MODERATE_READ_SCOPES = [
    'moderator:read:blocked_terms', 'moderator:read:chat_settings', 'moderator:read:unban_requests',
    'moderator:read:banned_users', 'moderator:read:chat_messages', 'moderator:read:warnings',
    'moderator:read:moderators', 'moderator:read:vips',
  ];

  it('none of the 8 moderate scope groups present -> hasAllModerateScopes false', async () => {
    const scopes = ['channel:read:redemptions', 'channel:read:hype_train', 'channel:read:ads', 'bits:read'];
    vi.stubGlobal('fetch', stubValidate(scopes));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeScopeCheckHub();

    await hub.logEventSubScopeCheck();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasAllModerateScopes":false'));
    expect(hub.esScopeCheckResult.hasAllModerateScopes).toBe(false);
    logSpy.mockRestore();
  });

  it('all 8 moderate scope groups present (read variant) -> hasAllModerateScopes true, independent of the other 4 EventSub scopes', async () => {
    vi.stubGlobal('fetch', stubValidate(ALL_MODERATE_READ_SCOPES)); // deliberately WITHOUT bits:read/redemptions/etc
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeScopeCheckHub();

    await hub.logEventSubScopeCheck();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasAllModerateScopes":true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasAllEventSubScopes":false')); // independent booleans
    expect(hub.esScopeCheckResult.hasAllModerateScopes).toBe(true);
    logSpy.mockRestore();
  });

  it('a manage:* scope satisfies its OR-group exactly like the read:* variant', async () => {
    // moderator:read:moderators/vips have no manage:* alternative (per Twitch's
    // docs, unlike the other 6 groups) — swap one of the 6 real OR-pairs instead.
    const scopes = ALL_MODERATE_READ_SCOPES.filter((s) => s !== 'moderator:read:blocked_terms').concat('moderator:manage:blocked_terms');
    vi.stubGlobal('fetch', stubValidate(scopes));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeScopeCheckHub();

    await hub.logEventSubScopeCheck();

    expect(hub.esScopeCheckResult.hasAllModerateScopes).toBe(true);
    logSpy.mockRestore();
  });

  it('one moderate scope group missing (e.g. warnings) -> hasAllModerateScopes false even though 7 of 8 are present', async () => {
    const scopes = ALL_MODERATE_READ_SCOPES.filter((s) => s !== 'moderator:read:warnings');
    vi.stubGlobal('fetch', stubValidate(scopes));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = makeScopeCheckHub();

    await hub.logEventSubScopeCheck();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hasAllModerateScopes":false'));
    expect(hub.esScopeCheckResult.hasAllModerateScopes).toBe(false);
    logSpy.mockRestore();
  });
});

// ── ChatHub.createEventSubSubscription — channel.bits.use 403 diagnosis ───
describe('ChatHub.createEventSubSubscription: channel.bits.use 403 diagnosis', () => {
  const callback = 'https://multichat.example.com/eventsub/callback';
  const bitsWant = { type: 'channel.bits.use', version: '1', condition: { broadcaster_user_id: '42' } };

  function stub403(bodyText = '{"error":"Forbidden","status":403,"message":"missing scope"}') {
    return vi.fn(async () => new Response(bodyText, { status: 403 }));
  }

  it("esScopeCheckResult.hasBitsRead === false -> diagnosis: 'scope_not_granted'", async () => {
    vi.stubGlobal('fetch', stub403());
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub();
    hub.esScopeCheckResult = { hasBitsRead: false, hasAllEventSubScopes: false, checkedAt: Date.now() };

    await hub.createEventSubSubscription('app-token', bitsWant, callback);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"diagnosis":"scope_not_granted"'));
    errSpy.mockRestore();
  });

  it("esScopeCheckResult.hasBitsRead === true -> diagnosis: 'not_a_scope_issue'", async () => {
    vi.stubGlobal('fetch', stub403());
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub();
    hub.esScopeCheckResult = { hasBitsRead: true, hasAllEventSubScopes: true, checkedAt: Date.now() };

    await hub.createEventSubSubscription('app-token', bitsWant, callback);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"diagnosis":"not_a_scope_issue"'));
    errSpy.mockRestore();
  });

  it("esScopeCheckResult === null (never checked) -> diagnosis: 'scope_check_unavailable'", async () => {
    vi.stubGlobal('fetch', stub403());
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub();
    expect(hub.esScopeCheckResult).toBeNull();

    await hub.createEventSubSubscription('app-token', bitsWant, callback);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"diagnosis":"scope_check_unavailable"'));
    errSpy.mockRestore();
  });

  it('a DIFFERENT subscription type (e.g. channel.ad_break.begin) with a 403 gets NO diagnosis field at all', async () => {
    vi.stubGlobal('fetch', stub403());
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub();
    hub.esScopeCheckResult = { hasBitsRead: false, hasAllEventSubScopes: false, checkedAt: Date.now() };
    const adBreakWant = { type: 'channel.ad_break.begin', version: '1', condition: { broadcaster_user_id: '42' } };

    await hub.createEventSubSubscription('app-token', adBreakWant, callback);

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errSpy.mock.calls[0][0]);
    expect(logged.ev).toBe('eventsub_create_failed');
    expect(logged).not.toHaveProperty('diagnosis');
    errSpy.mockRestore();
  });

  it('a channel.bits.use failure with status 400 (not 403) gets NO diagnosis field at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Bad Request"}', { status: 400 })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = makeEventSubHub();
    hub.esScopeCheckResult = { hasBitsRead: false, hasAllEventSubScopes: false, checkedAt: Date.now() };

    await hub.createEventSubSubscription('app-token', bitsWant, callback);

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errSpy.mock.calls[0][0]);
    expect(logged.ev).toBe('eventsub_create_failed');
    expect(logged).not.toHaveProperty('diagnosis');
    errSpy.mockRestore();
  });
});

// ── ChatHub.esModerateHealthy — persistence + hydration ────────────────────
// Must survive a DO cold start (eviction between streams, a redeploy) — an
// in-memory-only flag would default false on every fresh instance while the
// Twitch-side subscription is still genuinely enabled from before, which is
// exactly the double-row race this design exists to prevent. See
// docs/ARCHITECTURE.md §3a for the accepted mirror-window this does NOT
// close (a revocation landing between the last persist and eviction).
describe('ChatHub.esModerateHealthy — persistence + hydration', () => {
  const origin = 'https://multichat.example.com';
  const callback = `${origin}/eventsub/callback`;

  it('a reconcile that finds channel.moderate enabled persists esModerateHealthy:true to storage, not just in-memory', async () => {
    const existingSubs = buildDesiredSubs('42').map((want, i) => ({
      id: `sub-${i}`, type: want.type, version: want.version, status: 'enabled',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      condition: want.condition, transport: { callback },
    }));
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock(existingSubs, calls)));
    const storage = makeStorage();
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }, storage);
    await hub.ctx.pendingBlockConcurrencyWhile; // let construction-time hydration settle first

    await hub.ensureEventSubSubscriptions(origin);

    expect(hub.esModerateHealthy).toBe(true);
    expect(storage._map.get('esModerateHealthy')).toBe(true);
  });

  it('a reconcile that finds channel.moderate missing/dead persists esModerateHealthy:false', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(fetchMock([], calls))); // nothing exists — every sub gets created, none enabled yet
    const storage = makeStorage({ esModerateHealthy: true }); // stale true from a prior healthy period
    const hub = makeEventSubHub({ EVENTSUB_SECRET: 's3cret', TWITCH_BROADCASTER_ID: '42' }, storage);
    await hub.ctx.pendingBlockConcurrencyWhile;
    expect(hub.esModerateHealthy).toBe(true); // hydrated from the stale-true storage first

    await hub.ensureEventSubSubscriptions(origin);

    expect(hub.esModerateHealthy).toBe(false); // reconcile observed it's actually missing and corrected the flag
    expect(storage._map.get('esModerateHealthy')).toBe(false);
  });

  it('hydrates esModerateHealthy:true from storage on construction (cold-start survival) — never the bare false default while a value is persisted', async () => {
    const storage = makeStorage({ esModerateHealthy: true });
    const hub = makeEventSubHub({}, storage);
    await hub.ctx.pendingBlockConcurrencyWhile;
    expect(hub.esModerateHealthy).toBe(true);
  });

  it('defaults to false only when no value has ever been persisted (first boot / pre-feature DO)', async () => {
    const storage = makeStorage(); // no esModerateHealthy key at all
    const hub = makeEventSubHub({}, storage);
    await hub.ctx.pendingBlockConcurrencyWhile;
    expect(hub.esModerateHealthy).toBe(false);
  });
});

// ── applyClearchat / applyClearmsg — IRC vs channel.moderate ownership ─────
// The strike-mark (markDeleted) always happens regardless of ownership — IRC
// is fast and works even if EventSub lags or drops. Only the gray
// ATTRIBUTION row is gated: channel.moderate owns it once healthy (renders
// separately via mapEventToRow), IRC's own target-only row is the fallback.
// One timeout/ban/delete must never produce two rows. Neither applyClearchat
// nor applyClearmsg had direct tests before this feature (only their YouTube
// analogs, in test/yt-mod-actions.test.js, did) — see docs/ARCHITECTURE.md §3a.
describe('applyClearchat / applyClearmsg — IRC vs channel.moderate ownership', () => {
  it('esModerateHealthy=false (today\'s behavior): applyClearchat timeout strikes the row AND pushes the gray "timeout:" row', () => {
    const hub = makeEventSubHub();
    hub.esModerateHealthy = false;
    hub.pushMessage('tw', { user: 'Alice', login: 'alice', text: 'hi' });
    hub.applyClearchat({ login: 'alice', seconds: 600 });
    expect(hub.ring.find((e) => e.login === 'alice' && e.text === 'hi').deleted).toBe(true);
    const infoRow = hub.ring[hub.ring.length - 1];
    expect(infoRow.sys).toBe('timeout');
    expect(infoRow.text).toBe('timeout: alice, 600s');
  });

  it('esModerateHealthy=true: applyClearchat timeout still strikes the row but suppresses the gray row (channel.moderate owns it)', () => {
    const hub = makeEventSubHub();
    hub.esModerateHealthy = true;
    hub.pushMessage('tw', { user: 'Alice', login: 'alice', text: 'hi' });
    hub.applyClearchat({ login: 'alice', seconds: 600 });
    expect(hub.ring.find((e) => e.login === 'alice' && e.text === 'hi').deleted).toBe(true);
    expect(hub.ring[hub.ring.length - 1].sys).not.toBe('timeout'); // no second row — only the strike-marked message itself
    expect(hub.ring).toHaveLength(1); // the original message, nothing appended
  });

  it('esModerateHealthy=false: applyClearchat ban strikes and pushes the gray "ban:" row', () => {
    const hub = makeEventSubHub();
    hub.esModerateHealthy = false;
    hub.applyClearchat({ login: 'baduser', seconds: null });
    const infoRow = hub.ring[hub.ring.length - 1];
    expect(infoRow.sys).toBe('ban');
    expect(infoRow.text).toBe('ban: baduser');
  });

  it('esModerateHealthy=true: applyClearchat ban strikes but suppresses the gray row', () => {
    const hub = makeEventSubHub();
    hub.esModerateHealthy = true;
    hub.pushMessage('tw', { user: 'Bob', login: 'baduser', text: 'spam' });
    hub.applyClearchat({ login: 'baduser', seconds: null });
    expect(hub.ring.find((e) => e.login === 'baduser' && e.text === 'spam').deleted).toBe(true);
    expect(hub.ring).toHaveLength(1);
  });

  it('bare CLEARCHAT (full clear) always pushes "chat cleared", regardless of esModerateHealthy (channel.moderate never renders a clear action)', () => {
    for (const esModerateHealthy of [true, false]) {
      const hub = makeEventSubHub();
      hub.esModerateHealthy = esModerateHealthy;
      hub.applyClearchat({ clear: true });
      const infoRow = hub.ring[hub.ring.length - 1];
      expect(infoRow.sys).toBe('clear');
      expect(infoRow.text).toBe('chat cleared');
    }
  });

  it('esModerateHealthy=false: applyClearmsg strikes the target message AND pushes the gray "deleted" row', () => {
    const hub = makeEventSubHub();
    hub.esModerateHealthy = false;
    hub.pushMessage('tw', { user: 'Alice', login: 'alice', text: 'hi' }, { id: 'msg-1' });
    hub.applyClearmsg({ targetId: 'msg-1', login: 'alice' });
    expect(hub.ring.find((e) => e.twId === 'msg-1').deleted).toBe(true);
    const infoRow = hub.ring[hub.ring.length - 1];
    expect(infoRow.sys).toBe('deleted');
    expect(infoRow.text).toBe("alice's message deleted");
  });

  it('esModerateHealthy=true: applyClearmsg strikes the target message but suppresses the gray row (channel.moderate owns it)', () => {
    const hub = makeEventSubHub();
    hub.esModerateHealthy = true;
    hub.pushMessage('tw', { user: 'Alice', login: 'alice', text: 'hi' }, { id: 'msg-1' });
    hub.applyClearmsg({ targetId: 'msg-1', login: 'alice' });
    expect(hub.ring.find((e) => e.twId === 'msg-1').deleted).toBe(true);
    expect(hub.ring).toHaveLength(1); // no second row appended
  });
});
