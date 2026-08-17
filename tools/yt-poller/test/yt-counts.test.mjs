// videoId lifecycle + counts fetch — see yt-counts.mjs. No network in the
// lifecycle tests (pure state machine); fetchYtCounts tests stub global
// fetch, same pattern as the worker's Twitch Helix tests.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createVideoIdTracker, fetchYtCounts, fetchYtVideoState } from '../yt-counts.mjs';

describe('createVideoIdTracker', () => {
  it('starts with no id', () => {
    const t = createVideoIdTracker();
    expect(t.get()).toBeNull();
  });

  it('onStart sets the id from the live session', () => {
    const t = createVideoIdTracker();
    t.onStart('abc123');
    expect(t.get()).toBe('abc123');
  });

  it('onStart with a falsy liveId clears to null rather than storing garbage', () => {
    const t = createVideoIdTracker();
    t.onStart('abc123');
    t.onStart(undefined);
    expect(t.get()).toBeNull();
  });

  it('onEnd clears the id — an ended session must never keep reporting counts', () => {
    const t = createVideoIdTracker();
    t.onStart('abc123');
    t.onEnd();
    expect(t.get()).toBeNull();
  });

  it('reset clears the id (covers a run() cycle whose start() never succeeded)', () => {
    const t = createVideoIdTracker();
    t.onStart('abc123');
    t.reset();
    expect(t.get()).toBeNull();
  });
});

describe('fetchYtCounts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null with no apiKey, without attempting a fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchYtCounts('vid1', undefined, { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null with no videoId (session not live), without attempting a fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchYtCounts(null, 'key123', { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses concurrentViewers + likeCount from a successful videos.list response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ liveStreamingDetails: { concurrentViewers: '1234' }, statistics: { likeCount: '567' } }],
      }),
    });
    const result = await fetchYtCounts('vid1', 'key123', { fetchImpl });
    expect(result).toEqual({ viewers: 1234, likes: 567 });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('id=vid1');
    expect(url).toContain('key=key123');
    expect(url).toContain('part=liveStreamingDetails,statistics');
  });

  it('returns only the fields present when one of the two is missing/non-numeric', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ liveStreamingDetails: { concurrentViewers: '42' }, statistics: {} }] }),
    });
    const result = await fetchYtCounts('vid1', 'key123', { fetchImpl });
    expect(result).toEqual({ viewers: 42 });
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const result = await fetchYtCounts('vid1', 'key123', { fetchImpl });
    expect(result).toBeNull();
  });

  it('returns null when items is empty (video not found / not live)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const result = await fetchYtCounts('vid1', 'key123', { fetchImpl });
    expect(result).toBeNull();
  });

  it('returns null and never throws on a network/timeout error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(fetchYtCounts('vid1', 'key123', { fetchImpl })).resolves.toBeNull();
  });

  // ADD 2 (round-3 audit): standalone, response-shape-independent — the
  // happy-path test above also checks this URL, but it dies with any
  // refactor of that test's fixture. If `part` ever drops
  // liveStreamingDetails, every videos.list response omits actualStartTime,
  // the watchdog gate reads not_live forever, and nothing in the logs says
  // so — the worst outcome available in this feature. This test exists so
  // that regression fails loudly, on its own, regardless of what happens to
  // the counts-parsing tests around it.
  it('part must request liveStreamingDetails — the watchdog gate depends on it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    await fetchYtCounts('vid1', 'key123', { fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('part=liveStreamingDetails,statistics');
  });
});

describe('fetchYtVideoState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no apiKey ⇒ counts null, liveness unknown, no fetch attempted', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchYtVideoState('vid1', undefined, { fetchImpl });
    expect(result.counts).toBeNull();
    expect(result.liveness.state).toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no videoId ⇒ counts null, liveness unknown, no fetch attempted', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchYtVideoState(null, 'key123', { fetchImpl });
    expect(result.counts).toBeNull();
    expect(result.liveness.state).toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('single fetch serves both counts and liveness (Change 1 — no doubled quota spend)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          liveStreamingDetails: { concurrentViewers: '1234', actualStartTime: '2026-08-17T01:00:00Z' },
          statistics: { likeCount: '567' },
        }],
      }),
    });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.counts).toEqual({ viewers: 1234, likes: 567 });
    expect(result.liveness.state).toBe('live');
    expect(result.liveness.at).toEqual(expect.any(Number));
  });

  it('actualStartTime set, actualEndTime absent ⇒ live', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ liveStreamingDetails: { actualStartTime: '2026-08-17T01:00:00Z' } }] }),
    });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(result.liveness.state).toBe('live');
  });

  it('liveStreamingDetails present, actualEndTime set ⇒ not_live', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ liveStreamingDetails: { actualStartTime: '2026-08-16T22:00:00Z', actualEndTime: '2026-08-17T01:00:00Z' } }],
      }),
    });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(result.liveness.state).toBe('not_live');
  });

  it('liveStreamingDetails present, actualStartTime absent ⇒ not_live (the burst 1-5 waiting-room shape)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ liveStreamingDetails: {} }] }),
    });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(result.liveness.state).toBe('not_live');
  });

  it('HTTP 404 on a videoId we hold ⇒ not_live (FIX 1 — the API\'s own positive statement)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(result.liveness.state).toBe('not_live');
    expect(result.counts).toBeNull();
  });

  it('ADD 1 — liveStreamingDetails missing entirely from a present item ⇒ unknown, never not_live', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ statistics: { likeCount: '5' } }] }),
    });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(result.liveness.state).toBe('unknown');
  });

  it('FIX 1 — HTTP 200 with items empty ⇒ unknown, not not_live (also the transient-API-weirdness shape)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(result.liveness.state).toBe('unknown');
  });

  it('non-404 HTTP error (quota/403) ⇒ unknown, never not_live', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    expect(result.liveness.state).toBe('unknown');
  });

  it('network/timeout error ⇒ unknown, never throws, never not_live', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(fetchYtVideoState('vid1', 'key123', { fetchImpl })).resolves.toMatchObject({
      counts: null,
      liveness: { state: 'unknown' },
    });
  });

  it('malformed JSON body ⇒ unknown, never throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    });
    await expect(fetchYtVideoState('vid1', 'key123', { fetchImpl })).resolves.toMatchObject({
      counts: null,
      liveness: { state: 'unknown' },
    });
  });

  it('absent concurrentViewers is never read as not_live evidence (round-3 audit burst 5: absent for hours on a not_live video)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ liveStreamingDetails: { actualStartTime: '2026-08-17T01:00:00Z' } }] }),
    });
    const result = await fetchYtVideoState('vid1', 'key123', { fetchImpl });
    // No concurrentViewers field anywhere in the fixture, actualStartTime IS
    // set ⇒ still reads live, proving concurrentViewers absence isn't
    // consulted at all.
    expect(result.liveness.state).toBe('live');
    expect(result.counts).toBeNull(); // no numeric fields present, correctly null
  });
});
