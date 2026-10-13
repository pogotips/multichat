// POST /translate through the real fetch dispatch + a real ChatHub (same
// scaffolding as tts-endpoint.test.js).
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/worker.js';
import { makeHub, makeStorage } from './helpers/makeHub.js';
import { estimateTokens, neuronsFor, NEURON_RATES } from '../src/lib.js';

const VIEW = 'view-secret-test';
const OVERLAY = 'ov-secret-test';
const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const FALLBACK = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
const MAX_RATES = { in: 9091, out: 34868 }; // pre-charge rate: max of both models

function setup({ ai, storage } = {}) {
  const { hub } = makeHub({ storage });
  const pending = [];
  const env = {
    MULTICHAT_VIEW_SECRET: VIEW,
    MULTICHAT_OVERLAY_SECRET: OVERLAY,
    HUB: { getByName: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) },
    ...(ai ? { AI: ai } : {}),
  };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const post = (text, token = VIEW, raw) => worker.fetch(new Request('https://x/translate?t=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify({ text }),
  }), env, ctx);
  const settle = () => Promise.all(pending);
  return { hub, env, post, settle };
}
const aiOk = (resp = { response: 'Hello', usage: { prompt_tokens: 50, completion_tokens: 10 } }) => ({ run: vi.fn(async () => resp) });

afterEach(() => vi.restoreAllMocks());

describe('POST /translate auth', () => {
  it('401 with no token', async () => {
    const { env } = setup({ ai: aiOk() });
    const res = await worker.fetch(new Request('https://x/translate', { method: 'POST', body: '{"text":"hola"}' }), env, {});
    expect(res.status).toBe(401);
  });
  it('401 with the wrong token', async () => {
    expect((await setup({ ai: aiOk() }).post('hola', 'nope')).status).toBe(401);
  });
  it('rejects the overlay secret', async () => {
    const ai = aiOk();
    const res = await setup({ ai }).post('hola', OVERLAY);
    expect(res.status).toBe(401);
    expect(ai.run).not.toHaveBeenCalled();
  });
  it('view secret -> 200', async () => {
    expect((await setup({ ai: aiOk() }).post('hola')).status).toBe(200);
  });
});

describe('POST /translate body handling', () => {
  it('413 over 2048 bytes', async () => {
    expect((await setup({ ai: aiOk() }).post('x'.repeat(3000))).status).toBe(413);
  });
  it('400 bad json', async () => {
    expect((await setup({ ai: aiOk() }).post(null, VIEW, '{nope')).status).toBe(400);
  });
  it('400 non-string text', async () => {
    expect((await setup({ ai: aiOk() }).post(5)).status).toBe(400);
  });
  it('links-only text -> empty, no AI call, no charge', async () => {
    const ai = aiOk();
    const s = setup({ ai });
    const j = await (await s.post('https://example.com/a')).json();
    expect(j).toEqual({ ok: false, reason: 'empty' });
    expect(ai.run).not.toHaveBeenCalled();
    expect(await s.hub.ctx.storage.get('translateDaily')).toBeUndefined();
  });
});

describe('POST /translate success paths', () => {
  it('translates and settles to real usage', async () => {
    const ai = aiOk();
    const s = setup({ ai });
    const j = await (await s.post('hola amigo')).json();
    expect(j).toEqual({ ok: true, text: 'Hello' });
    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, input] = ai.run.mock.calls[0];
    expect(model).toBe(MODEL);
    expect(input.messages[0].role).toBe('system');
    expect(input.messages[1].content).toBe('hola amigo');
    expect(input.max_completion_tokens).toBe(200);
    await s.settle();
    const d = await s.hub.ctx.storage.get('translateDaily');
    expect(d.neurons).toBeCloseTo(neuronsFor(50, 10), 6);
  });
  it('without usage, settles with estimates', async () => {
    const ai = aiOk({ response: 'Hello friend' });
    const s = setup({ ai });
    await s.post('hola amigo');
    await s.settle();
    const sys = ai.run.mock.calls[0][1].messages[0].content;
    const estIn = estimateTokens(sys) + estimateTokens('hola amigo') + 8;
    const d = await s.hub.ctx.storage.get('translateDaily');
    expect(d.neurons).toBeCloseTo(neuronsFor(estIn, estimateTokens('Hello friend')), 6);
  });
  it('caps output at 400 chars', async () => {
    const j = await (await setup({ ai: aiOk({ response: 'y'.repeat(900) }) }).post('hola')).json();
    expect(j.text.length).toBe(400);
  });
  it('strips think blocks', async () => {
    const j = await (await setup({ ai: aiOk({ response: '<think>x</think>Hello' }) }).post('hola')).json();
    expect(j.text).toBe('Hello');
  });
  it('same text -> same:true', async () => {
    const j = await (await setup({ ai: aiOk({ response: 'Hello.' }) }).post('hello')).json();
    expect(j).toEqual({ ok: true, same: true });
  });
});

describe('POST /translate failures', () => {
  it('primary throws -> fallback model used once', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ response: 'Hello' });
    const j = await (await setup({ ai: { run } }).post('hola')).json();
    expect(j).toEqual({ ok: true, text: 'Hello' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toBe(MODEL);
    expect(run.mock.calls[1][0]).toBe(FALLBACK);
  });
  it('fallback success settles at llama rates', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ response: 'Hello', usage: { prompt_tokens: 60, completion_tokens: 20 } });
    const s = setup({ ai: { run } });
    await s.post('hola');
    await s.settle();
    const d = await s.hub.ctx.storage.get('translateDaily');
    expect(d.neurons).toBeCloseTo(neuronsFor(60, 20, NEURON_RATES[FALLBACK]), 6);
  });
  it('both throw -> failed, pre-charge kept', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const s = setup({ ai: { run } });
    const j = await (await s.post('hola')).json();
    expect(j).toEqual({ ok: false, reason: 'failed' });
    await s.settle();
    const sys = (run.mock.calls[0][1]).messages[0].content;
    const est = neuronsFor(estimateTokens(sys) + estimateTokens('hola') + 8, 200, MAX_RATES);
    expect((await s.hub.ctx.storage.get('translateDaily')).neurons).toBeCloseTo(est, 6);
  });
  it('no AI binding -> failed', async () => {
    const j = await (await setup().post('hola')).json();
    expect(j).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('POST /translate limits', () => {
  it('minute: 12 parallel -> at most 10 ok, rest minute', async () => {
    const s = setup({ ai: aiOk() });
    const js = await Promise.all(Array.from({ length: 12 }, () => s.post('hola').then((r) => r.json())));
    expect(js.filter((j) => j.ok).length).toBeLessThanOrEqual(10);
    expect(js.filter((j) => j.reason === 'minute').length).toBeGreaterThanOrEqual(2);
  });
  it('budget exhausted -> budget', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const s = setup({ ai: aiOk(), storage: makeStorage({ translateDaily: { day: today, neurons: 7999 } }) });
    expect(await (await s.post('hola')).json()).toEqual({ ok: false, reason: 'budget' });
  });
  it("yesterday's exhausted budget resets (UTC)", async () => {
    const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const s = setup({ ai: aiOk(), storage: makeStorage({ translateDaily: { day: y, neurons: 8000 } }) });
    expect((await (await s.post('hola')).json()).ok).toBe(true);
  });
  it('DO race: 40 concurrent allows never exceed the budget', async () => {
    const { hub } = makeHub();
    // Dodge the minute cap: this test targets the daily meter only.
    const res = await Promise.all(Array.from({ length: 40 }, () => {
      hub.translateMinuteWindow = Math.floor(Date.now() / 60_000);
      hub.translateMinuteCount = 0;
      return hub.fetch(new Request('https://do/translate-allow', { method: 'POST', body: JSON.stringify({ est: 300 }) })).then((r) => r.json());
    }));
    const allowed = res.filter((r) => r.ok).length;
    expect(allowed * 300).toBeLessThanOrEqual(8000);
    expect(allowed).toBeGreaterThan(0);
    expect((await hub.ctx.storage.get('translateDaily')).neurons).toBe(allowed * 300);
  });
  it('settle after day rollover is skipped', async () => {
    const stored = { day: '2000-01-01', neurons: 500 };
    const { hub } = makeHub({ storage: makeStorage({ translateDaily: stored }) });
    const r = await (await hub.fetch(new Request('https://do/translate-settle', { method: 'POST', body: JSON.stringify({ est: 100, actual: 10 }) }))).json();
    expect(r).toEqual({ ok: true, skipped: true });
    expect(await hub.ctx.storage.get('translateDaily')).toEqual({ day: '2000-01-01', neurons: 500 });
  });
});

describe('POST /translate logging privacy', () => {
  it('logs one summary line and never the text', async () => {
    const lines = [];
    vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
    const s = setup({ ai: aiOk({ response: 'hello everyone ZXQV', usage: { prompt_tokens: 40, completion_tokens: 8 } }) });
    await s.post('bonjour tout le monde ZXQV');
    await s.settle();
    const all = lines.join('\n');
    expect(all).not.toContain('ZXQV');
    const sums = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.ev === 'translate');
    expect(sums).toHaveLength(1);
    for (const k of ['ok', 'reason', 'ms', 'inTok', 'outTok', 'neuronsEst']) expect(sums[0]).toHaveProperty(k);
  });
});

describe('POST /translate error logging', () => {
  it('logs denied and bad-request reasons without fields or text', async () => {
    const lines = [];
    vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
    const s = setup({ ai: aiOk() });
    await s.post('hola', 'nope');
    await s.post('x'.repeat(3000));
    await s.post(null, VIEW, '{nope');
    await s.post(5);
    const evs = lines.map((l) => JSON.parse(l));
    expect(evs).toContainEqual({ ev: 'translate_denied' });
    expect(evs.filter((e) => e.ev === 'translate_bad_request').map((e) => e.reason)).toEqual(['too_large', 'bad_json', 'missing_text']);
  });
  it('redacts model errors that echo the input', async () => {
    const lines = [];
    vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
    const run = vi.fn(async (m, input) => { throw new Error('bad prompt: ' + input.messages[1].content); });
    const j = await (await setup({ ai: { run } }).post('bonjour ZXQV sentinel')).json();
    expect(j.reason).toBe('failed');
    expect(lines.join('\n')).not.toContain('ZXQV');
    expect(lines.some((l) => l.includes('translate_model_error') && l.includes('[redacted]'))).toBe(true);
  });
});

describe('DO meter storage errors', () => {
  it('allow returns failed (200) when storage.get throws once', async () => {
    const storage = makeStorage();
    const realGet = storage.get;
    let thrown = false;
    storage.get = async (k) => { if (k === 'translateDaily' && !thrown) { thrown = true; throw new Error('storage down'); } return realGet(k); };
    const { hub } = makeHub({ storage });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await hub.fetch(new Request('https://do/translate-allow', { method: 'POST', body: JSON.stringify({ est: 10 }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'failed' });
    const ok = await (await hub.fetch(new Request('https://do/translate-allow', { method: 'POST', body: JSON.stringify({ est: 10 }) }))).json();
    expect(ok.ok).toBe(true);
  });
  it('settle returns failed when storage throws', async () => {
    const storage = makeStorage();
    storage.get = async () => { throw new Error('storage down'); };
    const { hub } = makeHub({ storage });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await (await hub.fetch(new Request('https://do/translate-settle', { method: 'POST', body: JSON.stringify({ est: 1, actual: 1 }) }))).json();
    expect(r).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('translate page wiring', () => {
  const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };
  it('PWA has the client; overlay does not', async () => {
    const html = await (await worker.fetch(new Request('https://x/#t=x'), env, {})).text();
    for (const s of ['/translate?t=', "'xlate'", 'function translateLabel(', 'function translateRequestText(', 'translateCache.size >= 500']) expect(html).toContain(s);
    const ov = await (await worker.fetch(new Request('https://x/overlay?t=y'), env, {})).text();
    expect(ov).not.toContain('/translate');
  });
});

describe('POST /translate real Gemma shape', () => {
  const real = (message, finish = 'stop', reasoning = 0) => ({
    id: 'x', object: 'chat.completion', model: MODEL,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 50, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: reasoning } },
  });
  it('parses the documented shape and sends thinking-off + max_completion_tokens', async () => {
    const ai = aiOk(real({ role: 'assistant', content: 'Hello' }));
    const res = await setup({ ai }).post('hola');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.text).toBe('Hello');
    expect(ai.run.mock.calls[0]).toEqual([MODEL, expect.objectContaining({
      chat_template_kwargs: { enable_thinking: false },
      max_completion_tokens: expect.any(Number),
    })]);
    expect(ai.run.mock.calls[0][1]).not.toHaveProperty('max_tokens');
  });
  it('array content parts are joined', async () => {
    const ai = aiOk(real({ role: 'assistant', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }] }));
    const j = await (await setup({ ai }).post('hola')).json();
    expect(j.ok).toBe(true);
    expect(j.text).toBe('Hello there');
  });
  it('null content + length logs diagnostics without text', async () => {
    const ai = aiOk(real({ role: 'assistant', content: null }, 'length', 120));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await setup({ ai }).post('hola');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'failed' });
    const lines = log.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes('"ev":"translate"') && l.includes('empty_output'));
    expect(line).toBeTruthy();
    const ev = JSON.parse(line);
    expect(ev.reason).toBe('empty_output');
    expect(ev.finishReason).toBe('length');
    expect(ev.reasoningTok).toBe(120);
    expect(lines.join('\n')).not.toContain('hola');
  });
  it('fallback keeps the legacy input', async () => {
    const ai = { run: vi.fn() };
    ai.run.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ response: 'Hello' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const j = await (await setup({ ai }).post('hola')).json();
    expect(j.ok).toBe(true);
    expect(ai.run.mock.calls[1][0]).toBe(FALLBACK);
    expect(ai.run.mock.calls[1][1].max_tokens).toEqual(expect.any(Number));
    expect(ai.run.mock.calls[1][1]).not.toHaveProperty('chat_template_kwargs');
  });
});
