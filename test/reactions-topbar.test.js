// PWA topbar reactions strip — rolling 60s window, sort-by-count, hide-when-
// quiet/not-live, pulse-on-high-intensity. Drives the real extracted PWA
// <script> via test/helpers/vm-page-driver.mjs (same approach as
// test/debug-row.test.js) so this exercises the actual client code path, not
// a reimplementation of it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/worker.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };

async function extractPwaScript() {
  const res = await worker.fetch(new Request('https://x/#t=x'), env, {});
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> in PWA response');
  return m[1];
}

function statusFrame({ ytAge = 1000, reactions = null } = {}) {
  return {
    tw: null,
    yt: ytAge,
    counts: {},
    reactions,
  };
}

describe('PWA reactions strip', () => {
  let script;

  beforeEach(async () => {
    script = await extractPwaScript();
  });

  it('starts empty (no persistent vertical space) with no status received yet', () => {
    const { getElementById } = driveClientScriptSession(script);
    expect(getElementById('reactions').textContent).toBe('');
  });

  it('renders emoji sorted by count descending, capped at top 4', () => {
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', statusFrame({
      reactions: { emoji: { '🎉': 2, '❤': 9, '😂': 5, '👍': 7, '🔥': 1 }, intensity: 0.3, ts: 1 },
    }));
    expect(getElementById('reactions').textContent).toBe('❤9 👍7 😂5 🎉2');
  });

  it('stays empty while YT is not live, even with a reactions payload present', () => {
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', statusFrame({ ytAge: null, reactions: { emoji: { '❤': 9 }, intensity: 0.9, ts: 1 } }));
    expect(getElementById('reactions').textContent).toBe('');
  });

  it('clears immediately once YT liveness is lost, even if inside the 60s window', () => {
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', statusFrame({ reactions: { emoji: { '❤': 9 }, intensity: 0.2, ts: 1 } }));
    expect(getElementById('reactions').textContent).toBe('❤9');
    fireEvent('status', statusFrame({ ytAge: null, reactions: null }));
    expect(getElementById('reactions').textContent).toBe('');
  });

  it('dedupes the same server snapshot (same ts) arriving on a second unrelated status broadcast', () => {
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    const reactions = { emoji: { '❤': 9 }, intensity: 0.2, ts: 42 };
    fireEvent('status', statusFrame({ reactions }));
    fireEvent('status', statusFrame({ reactions })); // same ts — must not double-count
    expect(getElementById('reactions').textContent).toBe('❤9');
  });

  it('adds the pulse class when intensity crosses the 0.75 threshold, not below it', () => {
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', statusFrame({ reactions: { emoji: { '❤': 1 }, intensity: 0.5, ts: 1 } }));
    expect(getElementById('reactions').classList.contains('pulse')).toBe(false);
    fireEvent('status', statusFrame({ reactions: { emoji: { '❤': 1 }, intensity: 0.8, ts: 2 } }));
    expect(getElementById('reactions').classList.contains('pulse')).toBe(true);
  });

  it('formats counts >= 1000 as compact k-style, reusing the shared count formatter', () => {
    const { getElementById, fireEvent } = driveClientScriptSession(script);
    fireEvent('status', statusFrame({
      reactions: { emoji: { '❤': 1234, '🔥': 999 }, intensity: 0.1, ts: 1 },
    }));
    expect(getElementById('reactions').textContent).toBe('❤1.2k 🔥999');
  });

  describe('rolling-window decay', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('drops a burst once real time advances past the 60s window (checked on the next status push)', () => {
      vi.setSystemTime(0);
      const { getElementById, fireEvent } = driveClientScriptSession(script);
      fireEvent('status', statusFrame({ reactions: { emoji: { '❤': 9 }, intensity: 0.2, ts: 1 } }));
      expect(getElementById('reactions').textContent).toBe('❤9');
      vi.setSystemTime(61_000); // past REACTIONS_WINDOW_MS (60s)
      // A later status broadcast with no new burst (e.g. an unrelated viewer-
      // count change) still re-renders and must flush the now-stale entry.
      fireEvent('status', statusFrame({ reactions: null }));
      expect(getElementById('reactions').textContent).toBe('');
    });

    it('accumulates counts from two bursts still inside the window', () => {
      vi.setSystemTime(0);
      const { getElementById, fireEvent } = driveClientScriptSession(script);
      fireEvent('status', statusFrame({ reactions: { emoji: { '❤': 3 }, intensity: 0.1, ts: 1 } }));
      vi.setSystemTime(4_000);
      fireEvent('status', statusFrame({ reactions: { emoji: { '❤': 2 }, intensity: 0.1, ts: 2 } }));
      expect(getElementById('reactions').textContent).toBe('❤5');
    });
  });
});
