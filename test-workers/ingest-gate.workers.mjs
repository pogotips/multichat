// Phase 4 discriminating tests. Runs under
// real workerd via @cloudflare/vitest-pool-workers — NOT the plain-Node
// vitest pool test/pull-refresh.test.js uses. That distinction matters: this
// investigation needs to know whether workerd's real input-gate *dispatch*
// defers an incoming `/ingest/yt` request while another fetch() is already
// in flight on the same DO instance. Calling ChatHub methods directly (as
// the existing test suite does) skips the runtime's event-dispatch queue
// entirely, so there is no gate to observe either way — only a real
// workerd instance, reached through an actual DurableObjectStub, can answer
// this. Invoke via `npm run test:gate`, never part of `npm test`.
//
// Per the task's explicit instructions: use a *controllable delay*
// (comfortably past the poller's 10,000ms AbortSignal.timeout), not an
// indefinite hang — same fingerprint, no /etc/hosts, no DNS, no sudo, no
// change to DO source. The delay is parameterized so one harness produces
// both the H1 scenario (long delay, concurrent ingest) and a fast-path
// control (short delay) in the same file.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Fires pollTwitchViewers (the highest-exposure unbounded fetch per Phase 2,
// worker.js:1062) inside the DO instance without awaiting it — mirrors
// production's own fire-and-forget shape (startTwitchViewerPoll calls
// `this.pollTwitchViewers();` with no `await`, worker.js:996) — then, while
// that fetch is still pending, issues a real `/ingest/yt` POST through the
// DO's actual fetch handler (stub.fetch, not a direct method call) and
// measures wall-clock time to response.
async function probeGateBehavior(helixDelayMs, reqId) {
  const id = env.HUB.idFromName(`gate-test-${reqId}`);
  const stub = env.HUB.get(id);

  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('id.twitch.tv/oauth2/token')) {
      return { ok: true, json: async () => ({ access_token: 'gate-tok', expires_in: 3600 }) };
    }
    if (url.includes('api.twitch.tv/helix/streams')) {
      if (helixDelayMs > 0) await new Promise((r) => setTimeout(r, helixDelayMs));
      return { ok: true, json: async () => ({ data: [{ viewer_count: 1 }] }) };
    }
    throw new Error(`gate test: unexpected fetch to ${url}`);
  }));

  // Fire-and-forget, exactly like production's own setInterval callback —
  // deliberately not awaited here.
  runInDurableObject(stub, async (instance) => {
    instance.pollTwitchViewers();
  });

  // Let the fire-and-forget poll actually start (reach its first await)
  // before racing the ingest against it.
  await new Promise((r) => setTimeout(r, 10));

  const t0 = performance.now();
  const res = await stub.fetch('https://do/ingest/yt', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Multichat-Secret': env.MULTICHAT_INGEST_SECRET, 'X-Req-Id': reqId },
    body: JSON.stringify({ user: 'GateProbe', text: 'hi' }),
  });
  const elapsedMs = performance.now() - t0;

  return { res, elapsedMs };
}

describe('Phase 4a/4b: DO input-gate dispatch probe (real workerd)', () => {
  it('control: no concurrent delay — ingest returns fast, nothing to attribute', async () => {
    const { res, elapsedMs } = await probeGateBehavior(0, 'gate-control');
    expect(res.status).toBe(200);
    // Sanity ceiling, not a tight bound — this is the "nothing is hung"
    // baseline the delayed case gets compared against.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('H1 probe: ingest fired while pollTwitchViewers is mid-fetch, delayed 12000ms (past the poller\'s 10s abort ceiling)', async () => {
    const HELIX_DELAY_MS = 12_000;
    const { res, elapsedMs } = await probeGateBehavior(HELIX_DELAY_MS, 'gate-h1-probe');
    console.log(`[gate-probe] helixDelayMs=${HELIX_DELAY_MS} ingestElapsedMs=${elapsedMs.toFixed(1)}`);
    expect(res.status).toBe(200);

    // This is the measurement, not a pre-committed direction — Phase 4a
    // determined which side the result landed on and why. Both branches are asserted explicitly so a regression in
    // either direction fails loudly instead of silently changing meaning.
    if (elapsedMs >= HELIX_DELAY_MS - 500) {
      // H1's predicted fingerprint: the ingest was deferred until the
      // in-flight Helix fetch's gate reopened.
      expect(elapsedMs).toBeGreaterThanOrEqual(HELIX_DELAY_MS - 500);
    } else {
      // Docs-predicted fingerprint (Phase 1d): input gates protect only
      // ctx.storage ops, so a hung/slow plain fetch() does not defer a
      // concurrently-dispatched request — the ingest returns fast
      // regardless of the still-pending Helix fetch.
      expect(elapsedMs).toBeLessThan(2000);
    }
  }, 15_000);
});
