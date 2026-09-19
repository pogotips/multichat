// Overlay emoji-burst animation — off by default (OVERLAY_PARAM_SPEC's
// `reactions` param), spawn-rate capped, gated on the SAME toggle rule as
// gifAlt (query param on /overlay). Drives the real extracted overlay
// <script> via vm-page-driver.mjs, same approach as test/debug-row.test.js.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };

async function extractOverlayScript(query = '') {
  const res = await worker.fetch(new Request(`https://x/overlay?t=y${query}`), env, {});
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> in overlay response');
  return m[1];
}

function reactionsStatus(overrides = {}) {
  return { tw: null, yt: 1000, counts: {}, reactions: { emoji: { '❤': 3 }, intensity: 0.5, ts: 1 }, ...overrides };
}

describe('overlay reaction burst', () => {
  it('OVERLAY_PARAM_SPEC defaults reactions to off', async () => {
    const res = await worker.fetch(new Request('https://x/overlay?t=y'), env, {});
    const html = await res.text();
    expect(html).toContain('"reactions":"off"');
  });

  it('default (no ?reactions param): a nonzero burst spawns nothing into #reactions-burst', async () => {
    const script = await extractOverlayScript();
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', reactionsStatus());
    expect(getElementById('reactions-burst').children).toHaveLength(0);
  });

  it('?reactions=off explicitly: still spawns nothing', async () => {
    const script = await extractOverlayScript('&reactions=off');
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', reactionsStatus());
    expect(getElementById('reactions-burst').children).toHaveLength(0);
  });

  it('?reactions=on: a nonzero burst spawns particles', async () => {
    const script = await extractOverlayScript('&reactions=on');
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', reactionsStatus());
    expect(getElementById('reactions-burst').children.length).toBeGreaterThan(0);
  });

  it('?reactions=on: a zero/absent reactions field spawns nothing', async () => {
    const script = await extractOverlayScript('&reactions=on');
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', reactionsStatus({ reactions: null }));
    expect(getElementById('reactions-burst').children).toHaveLength(0);
  });

  it('?reactions=on: spawn count is capped at 8 per second even for a much larger burst', async () => {
    const script = await extractOverlayScript('&reactions=on');
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', reactionsStatus({ reactions: { emoji: { '❤': 50 }, intensity: 0.9, ts: 1 } }));
    expect(getElementById('reactions-burst').children).toHaveLength(8);
  });

  it('?reactions=on: dedupes the same server snapshot (same ts) across repeated status broadcasts', async () => {
    const script = await extractOverlayScript('&reactions=on');
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    const reactions = { emoji: { '❤': 3 }, intensity: 0.5, ts: 7 };
    fireEvent('status', reactionsStatus({ reactions }));
    fireEvent('status', reactionsStatus({ reactions }));
    expect(getElementById('reactions-burst').children).toHaveLength(3); // one burst's worth, not two
  });
});
