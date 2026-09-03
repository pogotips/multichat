// End-to-end POST /tts + POST /overlay/admin, through the REAL fetch
// dispatch (worker.fetch -> handleTts/handleOverlayAdmin -> a real ChatHub
// via a stub wrapper, not a canned mock) -- deliberately NOT unit-testing
// handleTts's pieces in isolation, since that's exactly the gap that let a
// missing `stripControlChars`/`stripUrls` import (caught only by an actual
// wrangler dev smoke test, not by overlay-lib.test.js's pure-function
// coverage) ship silently: those tests exercised the lib.js exports
// directly, never worker.js's own use of them.
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/worker.js';
import { makeHub } from './helpers/makeHub.js';

const OVERLAY_SECRET = 'ov-secret-test';
const ADMIN_SECRET = 'admin-secret-test';

function makeTtsEnv(overrides = {}) {
  const { hub } = makeHub();
  return {
    MULTICHAT_OVERLAY_SECRET: OVERLAY_SECRET,
    MULTICHAT_ADMIN_SECRET: ADMIN_SECRET,
    HUB: { getByName: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) },
    ...overrides,
  };
}

function postTts(env, text, token = OVERLAY_SECRET) {
  return worker.fetch(new Request(`https://x/tts?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }), env, {});
}

function postAdmin(env, body, token = OVERLAY_SECRET) {
  return worker.fetch(new Request(`https://x/overlay/admin?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env, {});
}

describe('POST /tts — auth', () => {
  it('401 with no token', async () => {
    const res = await worker.fetch(new Request('https://x/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    }), makeTtsEnv(), {});
    expect(res.status).toBe(401);
  });

  it('401 with the wrong token — the VIEW secret does NOT work here (R1: overlay-secret only)', async () => {
    const env = makeTtsEnv({ MULTICHAT_VIEW_SECRET: 'view-secret-test' });
    const res = await postTts(env, 'hi', 'view-secret-test');
    expect(res.status).toBe(401);
  });

  it('correct overlay token passes the gate (204 downstream, no AI binding locally)', async () => {
    const res = await postTts(makeTtsEnv(), 'hi');
    expect(res.status).toBe(204);
  });
});

describe('POST /tts — graceful degrade with no env.AI binding', () => {
  it('204, not 500, when env.AI is absent — this is the exact bug a missing lib.js import produced', async () => {
    const env = makeTtsEnv();
    expect(env.AI).toBeUndefined();
    const res = await postTts(env, 'hello test');
    expect(res.status).toBe(204);
  });
});

describe('POST /tts — text hardening reaches env.AI.run', () => {
  it('strips control chars and URLs, caps at 200 chars, before calling AI.run', async () => {
    const run = vi.fn(async () => new Response('fake-audio', { headers: { 'content-type': 'audio/mpeg' } }));
    const env = makeTtsEnv({ AI: { run } });
    const dirty = 'hey\x00 check https://example.com/x out ' + 'z'.repeat(250);
    const res = await postTts(env, dirty);
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input] = run.mock.calls[0];
    expect(model).toBe('@cf/deepgram/aura-2-en');
    expect(input.text.length).toBeLessThanOrEqual(200);
    expect(input.text).not.toMatch(/https?:\/\//);
    expect(input.text).not.toMatch(/\x00/);
  });

  it('empty text after sanitize (message was only a URL) never reaches AI.run', async () => {
    const run = vi.fn();
    const env = makeTtsEnv({ AI: { run } });
    const res = await postTts(env, 'https://example.com/only-a-link');
    expect(res.status).toBe(204);
    expect(run).not.toHaveBeenCalled();
  });

  it('AI.run throwing degrades to 204, not a 500', async () => {
    const run = vi.fn(async () => { throw new Error('boom'); });
    const env = makeTtsEnv({ AI: { run } });
    const res = await postTts(env, 'hello');
    expect(res.status).toBe(204);
  });

  it('malformed JSON body is a 204, not a 500', async () => {
    const env = makeTtsEnv({ AI: { run: vi.fn() } });
    const res = await worker.fetch(new Request(`https://x/tts?t=${OVERLAY_SECRET}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    }), env, {});
    expect(res.status).toBe(204);
  });
});

describe('POST /tts — DO-side gates (kill switch, minute ceiling, daily budget)', () => {
  it('kill switch set via /overlay/admin makes /tts return 204 without ever calling AI.run', async () => {
    const run = vi.fn(async () => new Response('audio'));
    const env = makeTtsEnv({ AI: { run } });
    const killRes = await postAdmin(env, { op: 'tts_kill', on: true });
    expect(killRes.status).toBe(200);
    expect(await killRes.json()).toEqual({ ok: true, killed: true });

    const res = await postTts(env, 'hello');
    expect(res.status).toBe(204);
    expect(run).not.toHaveBeenCalled();
  });

  it('unkill restores normal operation', async () => {
    const run = vi.fn(async () => new Response('audio'));
    const env = makeTtsEnv({ AI: { run } });
    await postAdmin(env, { op: 'tts_kill', on: true });
    await postAdmin(env, { op: 'tts_kill', on: false });
    const res = await postTts(env, 'hello');
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('20/min ceiling: the 21st call in the same minute is denied, the AI is called at most 20 times', async () => {
    const run = vi.fn(async () => new Response('audio'));
    const env = makeTtsEnv({ AI: { run } });
    const results = [];
    for (let i = 0; i < 21; i++) {
      results.push((await postTts(env, 'hi ' + i)).status);
    }
    expect(results.filter((s) => s === 200).length).toBe(20);
    expect(results.filter((s) => s === 204).length).toBe(1);
    expect(run).toHaveBeenCalledTimes(20);
  });

  it('20/min ceiling under real concurrency: 25 calls fired at once via Promise.all never let more than 20 through', async () => {
    // The sequential version above (await in a loop) can't catch a race
    // where the check and the increment straddle an await -- each call
    // there fully completes before the next one starts, so there's nothing
    // to interleave. Firing all calls via Promise.all lets them actually
    // race at the real await points inside handleTts/handleTtsAllow, the
    // same way concurrent OBS/browser sources hitting /tts genuinely would.
    const run = vi.fn(async () => new Response('audio'));
    const env = makeTtsEnv({ AI: { run } });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => postTts(env, 'hi ' + i))
    );
    const statuses = results.map((r) => r.status);
    const allowed = statuses.filter((s) => s === 200).length;
    const denied = statuses.filter((s) => s === 204).length;
    expect(allowed).toBeLessThanOrEqual(20);
    expect(allowed + denied).toBe(25);
    expect(run).toHaveBeenCalledTimes(allowed);
  });

  it('daily character budget: a call that would exceed the cap is denied, budget is persisted in ctx.storage (not in-memory)', async () => {
    const { hub } = makeHub();
    const env = {
      MULTICHAT_OVERLAY_SECRET: OVERLAY_SECRET,
      HUB: { getByName: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) },
      AI: { run: vi.fn(async () => new Response('audio')) },
    };
    // Directly exercise the DO gate to push near the 25,000-char daily cap
    // without needing 200+ HTTP round trips through the 20/min ceiling.
    const allowRes = await hub.fetch(new Request('https://do/tts-allow', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chars: 24_950 }),
    }));
    expect((await allowRes.json()).ok).toBe(true);

    const overBudget = await postTts(env, 'x'.repeat(100)); // would push past 25,000
    expect(overBudget.status).toBe(204);
    expect(env.AI.run).not.toHaveBeenCalled();

    // Confirm the budget really lives in ctx.storage, not an in-memory field
    // that would silently reset on DO eviction (gate-2 condition).
    const stored = await hub.ctx.storage.get('ttsDaily');
    expect(stored.chars).toBe(24_950);
  });

  it('daily budget window resets on a new UTC day (gate-2: UTC midnight, not rolling 24h)', async () => {
    const { hub } = makeHub({
      storage: undefined,
    });
    // Seed yesterday's (UTC) exhausted budget directly in storage.
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    await hub.ctx.storage.put('ttsDaily', { day: yesterday, chars: 25_000 });

    const allowRes = await hub.fetch(new Request('https://do/tts-allow', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chars: 100 }),
    }));
    const verdict = await allowRes.json();
    expect(verdict.ok).toBe(true); // yesterday's exhaustion does not carry over
  });

  it('concurrency: N parallel calls that together exceed the cap serialize -- stored total equals the sum of allowed calls, cap never exceeded (regression for the check-and-increment race)', async () => {
    const { hub } = makeHub();
    const perCall = 2000;
    const n = 15; // 15 * 2000 = 30,000 > the 25,000 cap; well under the 20/min ceiling so throttling never confounds this
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        hub.fetch(new Request('https://do/tts-allow', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chars: perCall }),
        })).then((r) => r.json())
      )
    );
    const allowed = results.filter((r) => r.ok);
    const denied = results.filter((r) => !r.ok);
    expect(allowed.length + denied.length).toBe(n);
    expect(allowed.length).toBeGreaterThan(0);
    expect(denied.length).toBeGreaterThan(0); // 15 * 2000 exceeds the cap, so some MUST be denied
    for (const r of denied) expect(r.reason).toBe('budget');

    const stored = await hub.ctx.storage.get('ttsDaily');
    // Without the blockConcurrencyWhile fix, a lost increment would make this
    // LESS than allowed.length * perCall -- every allowed call's charge must
    // survive, not just most of them.
    expect(stored.chars).toBe(allowed.length * perCall);
    expect(stored.chars).toBeLessThanOrEqual(25_000);
  });
});

describe('POST /overlay/admin — auth restored, shares MULTICHAT_OVERLAY_SECRET with /tts (no separate admin secret)', () => {
  it('401 with no token', async () => {
    const env = makeTtsEnv();
    const res = await worker.fetch(new Request('https://x/overlay/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'tts_kill', on: true }),
    }), env, {});
    expect(res.status).toBe(401);
  });

  it('401 with wrong token', async () => {
    const env = makeTtsEnv();
    const res = await postAdmin(env, { op: 'tts_kill', on: true }, 'wrong');
    expect(res.status).toBe(401);
  });

  it('correct overlay token passes the gate', async () => {
    const env = makeTtsEnv();
    const res = await postAdmin(env, { op: 'tts_kill', on: true });
    expect(res.status).toBe(200);
  });

  it('400 on an unknown op', async () => {
    const env = makeTtsEnv();
    const res = await postAdmin(env, { op: 'not_a_real_op' });
    expect(res.status).toBe(400);
  });

  it('the view secret has NO authority here', async () => {
    const env = makeTtsEnv({ MULTICHAT_VIEW_SECRET: 'view-secret-test' });
    const res = await postAdmin(env, { op: 'tts_kill', on: true }, 'view-secret-test');
    expect(res.status).toBe(401);
  });

  it('the ingest secret has NO authority here (R2) — vid poller value, rotated after a leak, must not gain kill-switch authority', async () => {
    const env = makeTtsEnv({ MULTICHAT_INGEST_SECRET: 'ingest-secret-test' });
    const res = await postAdmin(env, { op: 'tts_kill', on: true }, 'ingest-secret-test');
    expect(res.status).toBe(401);
  });

  it('the (retired) admin secret has NO authority here — MULTICHAT_ADMIN_SECRET is no longer checked anywhere', async () => {
    const env = makeTtsEnv();
    const res = await postAdmin(env, { op: 'tts_kill', on: true }, ADMIN_SECRET);
    expect(res.status).toBe(401);
  });

  it('the admin secret (retired) has NO authority on /tts either — it stays requireOverlayToken-only, the billed endpoint', async () => {
    const env = makeTtsEnv();
    const ttsRes = await postTts(env, 'hello', ADMIN_SECRET);
    expect(ttsRes.status).toBe(401);
  });
});
