// Tap-to-translate cache rules in the real PWA script (vm page driver):
// only a real translation and "already English" stick; a failed or limit-hit
// tap retries on the next tap; a tap while "translating…" is in flight does
// not send a second request.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import { translateRetryable } from '../src/lib.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'correct-secret' };

async function pwaScript() {
  const res = await worker.fetch(new Request('https://x/#t=correct-secret'), env, {});
  const m = (await res.text()).match(/<script>([\s\S]*?)<\/script>/);
  return m[1];
}

const flush = () => new Promise((r) => setImmediate(r));

// A fetch whose responses are scripted; each call is recorded.
function scriptedFetch(replies) {
  const calls = [];
  const gates = [];
  const impl = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === 'hang') return new Promise((resolve) => gates.push(resolve));
    if (reply === 'reject') return Promise.reject(new Error('net'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) });
  };
  return { impl, calls, gates };
}

async function setup(replies) {
  const f = scriptedFetch(replies);
  const s = driveClientScriptSession(await pwaScript(), { fetch: f.impl });
  s.fire({ id: 1, platform: 'tw', user: 'Alice', login: 'alice', text: 'hola amigo', ts: Date.now() });
  const row = s.feed.children[0];
  const target = { parentNode: row, tagName: 'SPAN', className: '', closest: (sel) => (sel === '.msg' ? row : null) };
  const feedClick = s.getElementById('feed')._listeners.click;
  return { f, row, tap: async () => { feedClick({ target }); await flush(); }, label: () => row.children[row.children.length - 1].textContent };
}

describe('translateRetryable', () => {
  it.each([
    [{ state: 'label', reason: 'failed' }, true],
    [{ state: 'label', reason: 'minute' }, true],
    [{ state: 'label', reason: 'budget' }, true],
    [{ state: 'label', reason: 'unauthorized' }, true],
    [{ state: 'label', reason: 'http_500' }, true],
    [{ state: 'label', reason: 'same' }, false],
    [{ state: 'label', reason: 'empty' }, false],
    [{ state: 'done', text: 'hello friend' }, false],
    [{ state: 'pending' }, false],
    [undefined, false],
  ])('%j -> %s', (entry, want) => expect(translateRetryable(entry)).toBe(want));
});

describe('PWA tap-to-translate caching', () => {
  it('failed then retry hits the network twice', async () => {
    const { f, tap, label } = await setup([{ ok: false, reason: 'failed' }, { ok: true, text: 'hello friend' }]);
    await tap();
    expect(f.calls).toHaveLength(1);
    expect(label()).toContain('failed');
    await tap();
    expect(f.calls).toHaveLength(2);
    expect(label()).toContain('hello friend');
  });

  it('a rejected fetch also retries', async () => {
    const { f, tap, label } = await setup(['reject', { ok: true, text: 'hello friend' }]);
    await tap();
    expect(label()).toContain('failed');
    await tap();
    expect(f.calls).toHaveLength(2);
    expect(label()).toContain('hello friend');
  });

  it('limit hit then retry hits the network twice', async () => {
    const { f, tap, label } = await setup([{ ok: false, reason: 'minute' }, { ok: true, text: 'hello friend' }]);
    await tap();
    expect(label()).toContain('limit hit');
    await tap();
    expect(f.calls).toHaveLength(2);
    expect(label()).toContain('hello friend');
  });

  it('success then re-tap is zero extra network', async () => {
    const { f, tap, label } = await setup([{ ok: true, text: 'hello friend' }]);
    await tap();
    await tap();
    await tap();
    expect(f.calls).toHaveLength(1);
    expect(label()).toContain('hello friend');
  });

  it('"already English" is cached: re-tap is zero extra network', async () => {
    const { f, tap, label } = await setup([{ ok: true, same: true }]);
    await tap();
    await tap();
    expect(f.calls).toHaveLength(1);
    expect(label()).toContain('already English');
  });

  it('double tap while in flight sends one request', async () => {
    const { f, tap, label } = await setup(['hang']);
    await tap();
    await tap();
    await tap();
    expect(f.calls).toHaveLength(1);
    expect(label()).toContain('translating');
    f.gates[0]({ ok: true, json: () => Promise.resolve({ ok: true, text: 'hello friend' }) });
    await flush();
    expect(label()).toContain('hello friend');
    expect(f.calls).toHaveLength(1);
  });
});
