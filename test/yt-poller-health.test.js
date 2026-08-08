// YT_FEED_LOSS_FORENSICS_2026-08-05.md rec 4: the poller's heartbeat now
// carries fetched/lastMessageAgeSec so CF Observability can see poller fetch
// health directly, without needing vid docker logs. This is unconditional
// on every heartbeat (health telemetry), distinct from the gated
// counts_update lines (viewer/like counts only log on change).
import { describe, it, expect, vi } from 'vitest';
import { makeHub } from './helpers/makeHub.js';
import { logEvents } from './helpers/logEvents.js';

function heartbeatReq(body) {
  return new Request('https://do/ingest/yt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('yt_poller_health log', () => {
  it('logs fetched/lastMessageAgeSec from a heartbeat body', async () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await hub.handleIngestYt(heartbeatReq({ type: 'heartbeat', fetched: 3, lastMessageAgeSec: 42 }));
    expect(logEvents(logSpy, 'yt_poller_health')).toEqual([
      expect.objectContaining({ fetched: 3, lastMessageAgeSec: 42 }),
    ]);
    logSpy.mockRestore();
  });

  it('logs null for missing/non-finite fields rather than throwing or omitting the line', async () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await hub.handleIngestYt(heartbeatReq({ type: 'heartbeat' }));
    expect(logEvents(logSpy, 'yt_poller_health')).toEqual([
      expect.objectContaining({ fetched: null, lastMessageAgeSec: null }),
    ]);
    logSpy.mockRestore();
  });

  it('logs unconditionally even when viewers/likes are unchanged (no counts_update)', async () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Two identical heartbeats: counts_update only fires on the first (change
    // from null), but yt_poller_health must log both times regardless.
    await hub.handleIngestYt(heartbeatReq({ type: 'heartbeat', fetched: 0, lastMessageAgeSec: 5, viewers: 10 }));
    await hub.handleIngestYt(heartbeatReq({ type: 'heartbeat', fetched: 0, lastMessageAgeSec: 20, viewers: 10 }));
    expect(logEvents(logSpy, 'yt_poller_health')).toHaveLength(2);
    logSpy.mockRestore();
  });
});
