// ?debug=1 topbar row (PWA only, never the overlay). Drives the real
// extracted client <script> the same way test/bundle-gif-render.test.js
// does (via test/helpers/vm-page-driver.mjs), but against plain source —
// no esbuild-mangling risk here since this code is written directly inside
// pageHtml's template-literal text, never passed through `${helperFn}`
// toString() interpolation.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };

async function extractScript(url) {
  const res = await worker.fetch(new Request(url), env, {});
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`no <script> in response for ${url}`);
  return m[1];
}

describe('?debug=1 topbar row', () => {
  it('PWA: CSS default is display:none', async () => {
    const res = await worker.fetch(new Request('https://x/'), env, {});
    const html = await res.text();
    expect(html).toMatch(/#debugRow\s*\{\s*display:\s*none/);
  });

  it('PWA: no ?debug param — script never touches the row', async () => {
    const script = await extractScript('https://x/#t=x');
    const { getElementById } = driveClientScriptSession(script);
    expect(getElementById('debugRow')).toBeNull();
  });

  it('PWA: ?debug=1 shows RELEASE_VERSION and gifs:on (default toggle state)', async () => {
    const script = await extractScript('https://x/?debug=1#t=x');
    const { getElementById } = driveClientScriptSession(script, { location: { search: '?debug=1' } });
    const debugRow = getElementById('debugRow');
    expect(debugRow.style.display).toBe('block');
    expect(debugRow.textContent).toMatch(/^v\d{4}\.\d{2}\.\d{2}\.\d+ · gifs: on$/);
  });

  it('PWA: ?debug=1 reflects gifs:off when localStorage has the toggle off', async () => {
    const script = await extractScript('https://x/?debug=1#t=x');
    const { getElementById } = driveClientScriptSession(script, {
      location: { search: '?debug=1' },
      localStorage: { 'multichat-gifs': 'off' },
    });
    const debugRow = getElementById('debugRow');
    expect(debugRow.textContent).toMatch(/gifs: off$/);
  });

  it('PWA: never leaks the view token into the debug row', async () => {
    const script = await extractScript('https://x/?debug=1#t=super-secret-token');
    const { getElementById } = driveClientScriptSession(script, { location: { search: '?debug=1' } });
    const debugRow = getElementById('debugRow');
    expect(debugRow.textContent).not.toContain('super-secret-token');
  });

  it('PWA: ?debug=1 row updates live when the gifs toggle is clicked after load (not just at page-load time)', async () => {
    const script = await extractScript('https://x/?debug=1#t=x');
    const { getElementById } = driveClientScriptSession(script, { location: { search: '?debug=1' } });
    expect(getElementById('debugRow').textContent).toMatch(/gifs: on$/);
    getElementById('gifsToggle').click();
    expect(getElementById('debugRow').textContent).toMatch(/gifs: off$/);
    getElementById('gifsToggle').click();
    expect(getElementById('debugRow').textContent).toMatch(/gifs: on$/);
  });

  it('overlay: no debugRow element/script wiring at all, even with ?debug=1', async () => {
    const res = await worker.fetch(new Request('https://x/overlay?debug=1&t=y'), env, {});
    const html = await res.text();
    expect(html).not.toContain('debugRow');
  });
});
