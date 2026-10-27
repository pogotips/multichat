// J16: the mark handlers' catches used to be bare (PWA and overlay) and the
// status catch too (overlay), so a throw inside them was invisible. Drives the
// real page scripts via the vm driver with a CSS.escape that throws, and
// asserts exactly one client-error beacon per failing mark frame.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };
const throwingCss = { escape: () => { throw new Error('boom'); } };
const MARK = { action: 'delete', platform: 'tw', targetId: 'msg-1' };

async function extractScript(url) {
  const res = await worker.fetch(new Request(url), env, {});
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> in response for ' + url);
  return m[1];
}

describe('mark handler failures are beaconed, not swallowed', () => {
  it('overlay: a throwing mark sends one /client-error with source overlay-mark', async () => {
    const script = await extractScript('https://x/overlay?t=y');
    const calls = [];
    const { fireEvent } = driveClientScriptSession(script, {
      fetch: (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); },
      extraGlobals: { CSS: throwingCss },
    });
    expect(fireEvent('mark', MARK)).toBe(true);
    const errs = calls.filter((c) => c.url.startsWith('/client-error'));
    expect(errs).toHaveLength(1);
    expect(errs[0].body.source).toBe('overlay-mark');
    expect(errs[0].body.message).toBe('Error: boom');
  });

  it('overlay: a healthy mark sends no beacon', async () => {
    const script = await extractScript('https://x/overlay?t=y');
    const calls = [];
    const { fireEvent } = driveClientScriptSession(script, {
      fetch: (url, opts) => { calls.push({ url }); return Promise.resolve({ ok: true }); },
    });
    fireEvent('mark', MARK);
    expect(calls.filter((c) => c.url.startsWith('/client-error'))).toHaveLength(0);
  });

  it('PWA: a throwing mark sends one beacon with source sse-mark', async () => {
    const script = await extractScript('https://x/#t=x');
    const { fireEvent, sentBeacons } = driveClientScriptSession(script, {
      extraGlobals: { CSS: throwingCss },
    });
    expect(fireEvent('mark', MARK)).toBe(true);
    const errs = sentBeacons.filter((b) => b.url.includes('/client-error'));
    expect(errs).toHaveLength(1);
    expect(JSON.parse(errs[0].body).source).toBe('sse-mark');
  });

  it('PWA: a healthy mark sends no beacon', async () => {
    const script = await extractScript('https://x/#t=x');
    const { fireEvent, sentBeacons } = driveClientScriptSession(script);
    fireEvent('mark', MARK);
    expect(sentBeacons).toHaveLength(0);
  });
});

// J16 (cont.): the overlay's onmessage and status catches now go through the
// shared beaconError helper; pin both sources so a swallowed throw there goes red.
describe('overlay onmessage / status failures are beaconed, not swallowed', () => {
  function overlay(query = '') {
    return extractScript(`https://x/overlay?t=y${query}`).then((script) => {
      const calls = [];
      const session = driveClientScriptSession(script, {
        fetch: (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); },
      });
      return { ...session, errs: () => calls.filter((c) => c.url.startsWith('/client-error')) };
    });
  }

  it('overlay: a frame that makes handleMsg throw sends one beacon with source overlay-onmessage', async () => {
    const { fire, errs } = await overlay();
    fire(null); // JSON "null" -> handleMsg(null) throws on msg.replay
    expect(errs()).toHaveLength(1);
    expect(errs()[0].body.source).toBe('overlay-onmessage');
    expect(errs()[0].body.message).toMatch(/^TypeError: /);
  });

  it('overlay: a throwing status handler sends one beacon with source overlay-status', async () => {
    const { fireEvent, getElementById, errs } = await overlay('&reactions=on');
    getElementById('reactions-burst').append = () => { throw new Error('boom'); };
    expect(fireEvent('status', { tw: null, yt: 1000, counts: {}, reactions: { emoji: { '❤': 3 }, intensity: 0.5, ts: 1 } })).toBe(true);
    expect(errs()).toHaveLength(1);
    expect(errs()[0].body.source).toBe('overlay-status');
    expect(errs()[0].body.message).toBe('Error: boom');
  });

  it('overlay: a healthy frame and a healthy status send no beacon', async () => {
    const { fire, fireEvent, errs } = await overlay('&reactions=on');
    fire({ id: 1, platform: 'tw', login: 'a', name: 'A', text: 'hi', ts: Date.now() });
    fireEvent('status', { tw: null, yt: 1000, counts: {}, reactions: { emoji: { '❤': 3 }, intensity: 0.5, ts: 1 } });
    expect(errs()).toHaveLength(0);
  });
});
