// Live viewer/like counts (top-bar chips): pure formatting/staleness helpers,
// Twitch Helix app-token polling, YouTube counts ingest, and the combined
// status payload. See CLAUDE.md / docs/ARCHITECTURE.md for the feature spec.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatCount, countField } from '../src/worker.js';
import { makeHub, makeStorage, req } from './helpers/makeHub.js';
import { withFakeTimers } from './helpers/withFakeTimers.js';

describe('formatCount', () => {
  it('renders sub-1000 values as plain integers', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(999)).toBe('999');
  });

  it('renders thousands as one-decimal k, trimming a trailing .0', () => {
    expect(formatCount(1000)).toBe('1k');
    expect(formatCount(1234)).toBe('1.2k');
    expect(formatCount(12500)).toBe('12.5k');
  });

  it('renders millions as one-decimal M', () => {
    expect(formatCount(1_000_000)).toBe('1M');
    expect(formatCount(2_340_000)).toBe('2.3M');
  });

  it('returns empty string for null/undefined/non-finite so the client hides the span', () => {
    expect(formatCount(null)).toBe('');
    expect(formatCount(undefined)).toBe('');
    expect(formatCount(NaN)).toBe('');
  });
});

describe('countField', () => {
  const now = 1_000_000;

  it('never-seen (null value) is not stale and carries v:null', () => {
    expect(countField(null, 0, 60_000, now)).toEqual({ v: null, stale: false });
  });

  it('fresh value under the threshold is not stale', () => {
    expect(countField(42, now - 10_000, 60_000, now)).toEqual({ v: 42, stale: false });
  });

  it('value past the threshold is stale but keeps v (dim, never blank)', () => {
    expect(countField(42, now - 61_000, 60_000, now)).toEqual({ v: 42, stale: true });
  });
});

describe('/ingest/yt heartbeat counts extension (regression-safe)', () => {
  it('populates ytViewers/ytLikes from a heartbeat carrying both fields', async () => {
    const { hub } = makeHub();
    const res = await hub.handleIngestYt(req({ type: 'heartbeat', viewers: 321, likes: 65 }));
    expect(res.status).toBe(200);
    expect(hub.ytViewers).toBe(321);
    expect(hub.ytLikes).toBe(65);
    expect(hub.ytCountsAt).toBeGreaterThan(0);
  });

  it('a plain heartbeat with neither field is untouched — existing liveness-only behavior unchanged', async () => {
    const { hub } = makeHub();
    const before = hub.lastSeen.yt;
    const res = await hub.handleIngestYt(req({ type: 'heartbeat' }));
    expect(res.status).toBe(200);
    expect(hub.lastSeen.yt).toBeGreaterThan(before);
    expect(hub.ytViewers).toBeNull();
    expect(hub.ytCountsAt).toBe(0);
  });

  it('a normal chat message payload is unaffected by the counts fields existing at all', async () => {
    const { hub } = makeHub();
    const res = await hub.handleIngestYt(req({ user: 'Alice', text: 'hi' }));
    expect(res.status).toBe(200);
    expect(hub.ring).toHaveLength(1);
    expect(hub.ring[0].user).toBe('Alice');
  });

  it('push-on-change: a heartbeat that changes a count broadcasts status immediately', async () => {
    const { hub } = makeHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    await hub.handleIngestYt(req({ type: 'heartbeat', viewers: 321, likes: 65 }));
    expect(broadcastSpy).toHaveBeenCalledWith('status', expect.any(Object));
  });

  it('push-on-change: a heartbeat repeating the same values does not broadcast', async () => {
    const { hub } = makeHub();
    hub.ytViewers = 321;
    hub.ytLikes = 65;
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    await hub.handleIngestYt(req({ type: 'heartbeat', viewers: 321, likes: 65 }));
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('push-on-change: a plain liveness heartbeat (no count fields) does not broadcast', async () => {
    const { hub } = makeHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    await hub.handleIngestYt(req({ type: 'heartbeat' }));
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});

describe('buildStatusPayload counts block', () => {
  it('includes null/not-stale counts when nothing has been polled yet', () => {
    const { hub } = makeHub();
    const status = hub.buildStatusPayload();
    expect(status.counts).toEqual({
      twViewers: { v: null, stale: false },
      twFollowers: { v: null, stale: false },
      ytViewers: { v: null, stale: false },
      ytLikes: { v: null, stale: false },
    });
  });

  it('reflects populated, fresh values', () => {
    const { hub } = makeHub();
    hub.twViewers = 100;
    hub.twViewersAt = Date.now();
    hub.twFollowers = 5000;
    hub.twFollowersAt = Date.now();
    hub.ytViewers = 200;
    hub.ytLikes = 30;
    hub.ytCountsAt = Date.now();
    const status = hub.buildStatusPayload();
    expect(status.counts.twViewers).toEqual({ v: 100, stale: false });
    expect(status.counts.twFollowers).toEqual({ v: 5000, stale: false });
    expect(status.counts.ytViewers).toEqual({ v: 200, stale: false });
    expect(status.counts.ytLikes).toEqual({ v: 30, stale: false });
  });

  it('marks a count stale after 2 missed polls without blanking it', () => {
    const { hub } = makeHub();
    hub.twViewers = 100;
    hub.twViewersAt = Date.now() - 31_000; // > 2 * 15s Helix poll
    const status = hub.buildStatusPayload();
    expect(status.counts.twViewers).toEqual({ v: 100, stale: true });
  });
});

describe('Twitch Helix viewer polling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no-ops (no fetch attempted) when TWITCH_CLIENT_ID/SECRET are unset — pre-registration state', async () => {
    const { hub } = makeHub();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchViewers();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hub.twViewers).toBeNull();
  });

  it('fetches a token then the stream, populating twViewers/twViewersAt', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 55 }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchViewers();
    expect(hub.twViewers).toBe(55);
    expect(hub.twViewersAt).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [tokenUrl] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe('https://id.twitch.tv/oauth2/token');
    const [streamUrl, streamOpts] = fetchSpy.mock.calls[1];
    expect(streamUrl).toContain('user_login=testchannel');
    expect(streamOpts.headers['Client-Id']).toBe('cid');
    expect(streamOpts.headers['Authorization']).toBe('Bearer tok1');
  });

  it('offline stream (empty data array) sets twViewers to null, not stale-forever garbage', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    hub.twViewers = 999; // stale prior value from when it WAS live
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchViewers();
    expect(hub.twViewers).toBeNull();
  });

  it('reuses a cached token across polls instead of re-fetching', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 10 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 20 }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchViewers();
    await hub.pollTwitchViewers();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 token fetch + 2 stream fetches, not 2+2
    expect(hub.twViewers).toBe(20);
  });

  it('a 401 on the stream call drops the cached token so the next poll refreshes it', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok2', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 5 }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchViewers();
    await hub.pollTwitchViewers();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(hub.twViewers).toBe(5);
  });

  it('a network failure leaves the last known value in place and never throws — chat flow is never touched', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    hub.twViewers = 77;
    hub.twViewersAt = 12345;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(hub.pollTwitchViewers()).resolves.toBeUndefined();
    expect(hub.twViewers).toBe(77);
    expect(hub.twViewersAt).toBe(12345);
  });

  it('an aborted app-token fetch (AbortSignal.timeout -> TimeoutError) is a transient failure — never touches ctx.storage, never blocks the next poll from retrying', async () => {
    const storage = makeStorage();
    const putSpy = vi.spyOn(storage, 'put');
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' }, storage });
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 42 }] }) });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(hub.pollTwitchViewers()).resolves.toBeUndefined();
    expect(hub.twViewers).toBeNull(); // no data — the abort short-circuited before any stream fetch
    expect(hub.twToken).toBeNull(); // no partial/invalid token cached from the aborted attempt
    expect(putSpy).not.toHaveBeenCalled(); // app-token path never touches the user-token refresh chain

    // Next cycle retries cleanly — the abort was never latched as a permanent failure.
    await hub.pollTwitchViewers();
    expect(hub.twViewers).toBe(42);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('push-on-change: a changed viewer count broadcasts status immediately', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    hub.twViewers = 10;
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 11 }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchViewers();
    expect(broadcastSpy).toHaveBeenCalledWith('status', expect.any(Object));
  });

  it('push-on-change: an unchanged viewer count does not broadcast', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    hub.twViewers = 10;
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ viewer_count: 10 }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchViewers();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('startHeartbeat/stopHeartbeat also start/stop the viewer-poll and follower-poll timers (gated on clients attached)', () => withFakeTimers(() => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    hub.startHeartbeat();
    expect(hub.twViewerPollTimer).not.toBeNull();
    expect(hub.twFollowerPollTimer).not.toBeNull();
    hub.stopHeartbeat();
    expect(hub.twViewerPollTimer).toBeNull();
    expect(hub.twFollowerPollTimer).toBeNull();
    expect(hub.heartbeatTimer).toBeNull();
  }));
});

describe('Twitch follower polling (moderator:read:followers, user-token refresh chain)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no-ops (no fetch attempted) when no refresh token exists anywhere — pre-consent state', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hub.twFollowers).toBeNull();
  });

  it('bootstraps from the seed secret on first use and persists the rotated refresh token to storage', async () => {
    const { hub } = makeHub({ envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', TWITCH_USER_REFRESH_TOKEN: 'seed-rt' } });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat1', refresh_token: 'rotated-rt-1', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 5000 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    expect(hub.twFollowers).toBe(5000);
    expect(hub.twFollowersAt).toBeGreaterThan(0);
    const [tokenUrl, tokenOpts] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe('https://id.twitch.tv/oauth2/token');
    expect(tokenOpts.body.get('grant_type')).toBe('refresh_token');
    expect(tokenOpts.body.get('refresh_token')).toBe('seed-rt');
    const [followersUrl, followersOpts] = fetchSpy.mock.calls[1];
    expect(followersUrl).toContain('broadcaster_id=');
    expect(followersOpts.headers['Authorization']).toBe('Bearer uat1');
    await expect(hub.ctx.storage.get('twUserRefreshToken')).resolves.toBe('rotated-rt-1');
  });

  it('storage refresh token wins over the seed secret once the chain has run', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', TWITCH_USER_REFRESH_TOKEN: 'stale-seed' },
      storage: makeStorage({ twUserRefreshToken: 'current-rt' }),
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat1', refresh_token: 'rotated-rt-2', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 100 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    const [, tokenOpts] = fetchSpy.mock.calls[0];
    expect(tokenOpts.body.get('refresh_token')).toBe('current-rt');
  });

  it('refresh-expiry: a cached access token past its expiry triggers a fresh refresh instead of reusing it', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' },
      storage: makeStorage({ twUserRefreshToken: 'current-rt' }),
    });
    hub.twUserToken = 'stale-access-token';
    hub.twUserTokenExp = Date.now() - 1; // already expired
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'fresh-uat', refresh_token: 'rotated-rt-3', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 42 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // refreshed, not reused
    const [, followersOpts] = fetchSpy.mock.calls[1];
    expect(followersOpts.headers['Authorization']).toBe('Bearer fresh-uat');
  });

  it('reuses a still-valid cached access token across polls without refreshing again', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' },
      storage: makeStorage({ twUserRefreshToken: 'current-rt' }),
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat1', refresh_token: 'rt2', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 10 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 11 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    await hub.pollTwitchFollowers();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 refresh + 2 followers calls, not 2+2
    expect(hub.twFollowers).toBe(11);
  });

  it('401 on the followers call drops only the cached access token, never the storage refresh chain', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' },
      storage: makeStorage({ twUserRefreshToken: 'current-rt' }),
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat1', refresh_token: 'rt2', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat2', refresh_token: 'rt3', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 7 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    expect(hub.twUserToken).toBeNull();
    await expect(hub.ctx.storage.get('twUserRefreshToken')).resolves.toBe('rt2'); // storage chain untouched by the 401
    await hub.pollTwitchFollowers();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(hub.twFollowers).toBe(7);
  });

  it('self-heal: a dead storage refresh token falls back to the seed secret once, then adopts it as the new chain head', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', TWITCH_USER_REFRESH_TOKEN: 'fresh-seed' },
      storage: makeStorage({ twUserRefreshToken: 'dead-rt' }),
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400 }) // dead stored token rejected
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat1', refresh_token: 'new-chain-rt', expires_in: 14400 }) }) // seed succeeds
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 999 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    expect(hub.twFollowers).toBe(999);
    await expect(hub.ctx.storage.get('twUserRefreshToken')).resolves.toBe('new-chain-rt');
  });

  it('both storage and seed dead: degrades to hidden, never throws', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', TWITCH_USER_REFRESH_TOKEN: 'dead-seed' },
      storage: makeStorage({ twUserRefreshToken: 'dead-rt' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(hub.pollTwitchFollowers()).resolves.toBeUndefined();
    expect(hub.twFollowers).toBeNull();
  });

  it('marks twFollowers stale after 2 missed polls without blanking it', () => {
    const { hub } = makeHub();
    hub.twFollowers = 5000;
    hub.twFollowersAt = Date.now() - 601_000; // > 2 * 5min follower poll
    const status = hub.buildStatusPayload();
    expect(status.counts.twFollowers).toEqual({ v: 5000, stale: true });
  });

  it('push-on-change: a changed follower total broadcasts status immediately, independent of the 25s heartbeat', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' },
      storage: makeStorage({ twUserRefreshToken: 'current-rt' }),
    });
    hub.twFollowers = 100;
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat1', refresh_token: 'rt2', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 101 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    expect(broadcastSpy).toHaveBeenCalledWith('status', expect.any(Object));
  });

  it('push-on-change: an unchanged follower total does not broadcast', async () => {
    const { hub } = makeHub({
      envOverrides: { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' },
      storage: makeStorage({ twUserRefreshToken: 'current-rt' }),
    });
    hub.twFollowers = 100;
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'uat1', refresh_token: 'rt2', expires_in: 14400 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 100 }) });
    vi.stubGlobal('fetch', fetchSpy);
    await hub.pollTwitchFollowers();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});
