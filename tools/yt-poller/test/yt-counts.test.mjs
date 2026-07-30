// videoId lifecycle + counts fetch — see yt-counts.mjs. No network in the
// lifecycle tests (pure state machine); fetchYtCounts tests stub global
// fetch, same pattern as the worker's Twitch Helix tests.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createVideoIdTracker, fetchYtCounts } from '../yt-counts.mjs';

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
});
