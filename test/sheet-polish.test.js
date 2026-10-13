// Name-tap sheet LOWs from the 2026-10-11 gate review (fixed 2026-10-12):
// pointer cursor only on feed names (sheet rows are not tappable), sheet
// colors as :root tokens, iOS scroll-lock on the feed behind an open sheet
// that releases on every close path, focus moved into the dialog and
// restored on close, and a touchmove guard on the dim area.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';

const env = { MULTICHAT_VIEW_SECRET: 'x' };

async function html(url) {
  const res = await worker.fetch(new Request(url), env, {});
  expect(res.status).toBe(200);
  return res.text();
}
const rule = (h, sel) => {
  const m = h.match(new RegExp(sel.replace(/[.#]/g, '\\$&') + ' \\{[^}]*\\}'));
  return m ? m[0] : null;
};
const fn = (h, name) => {
  const i = h.indexOf('function ' + name + '(');
  expect(i).toBeGreaterThan(-1);
  return h.slice(i, h.indexOf('\n  }\n', i) + 4);
};

describe('sheet polish (PWA)', () => {
  it('pointer cursor is feed-scoped: #feed .user has it, .user does not', async () => {
    const h = await html('https://x/#t=x');
    expect(rule(h, '.user')).not.toContain('cursor');
    expect(rule(h, '#feed .user')).toContain('cursor: pointer');
  });

  it('sheet colors come from :root tokens, not literals', async () => {
    const h = await html('https://x/#t=x');
    expect(rule(h, ':root')).toContain('--sheet-bg:');
    expect(rule(h, ':root')).toContain('--sheet-border:');
    expect(rule(h, '#sheet')).toContain('background: var(--sheet-bg)');
    expect(rule(h, '#sheet')).toContain('border-top: 1px solid var(--sheet-border)');
    expect(rule(h, '#sheetHead')).toContain('var(--sheet-border)');
    expect(rule(h, '#sheet')).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it('scroll-lock CSS: body.sheet-open freezes the feed; sheet list and backdrop contain overscroll', async () => {
    const h = await html('https://x/#t=x');
    expect(rule(h, 'body.sheet-open #feed')).toContain('overflow: hidden');
    expect(rule(h, 'body.sheet-open')).toContain('overflow: hidden');
    expect(rule(h, '#sheetList')).toContain('overscroll-behavior: contain');
    expect(rule(h, '#sheetBackdrop')).toContain('overscroll-behavior: contain');
  });

  it('openSheet adds the lock + moves focus; closeSheet (the only close path) releases both', async () => {
    const h = await html('https://x/#t=x');
    const open = fn(h, 'openSheet');
    const close = fn(h, 'closeSheet');
    expect(open).toContain("document.body.classList.add('sheet-open')");
    // focus origin captured only on a real open, never overwritten by a re-open
    expect(open).toContain('const wasOpen = sheetKey !== null;');
    expect(open).toContain('if (!wasOpen) sheetLastFocus = document.activeElement');
    expect(open).toContain('sheetClose.focus({ preventScroll: true })');
    expect(close).toContain("document.body.classList.remove('sheet-open')");
    expect(close).toContain('sheetLastFocus.focus({ preventScroll: true })');
    // every dismissal routes through closeSheet, nothing else touches the lock
    expect(h.match(/classList\.remove\('sheet-open'\)/g)).toHaveLength(1);
    expect(h).toContain("sheetBackdrop.addEventListener('click', (e) => { if (e.target === sheetBackdrop) closeSheet(); });");
    expect(h).toContain("sheetClose.addEventListener('click', closeSheet);");
    expect(h).toContain("if (e.key === 'Escape' && sheetKey !== null) closeSheet();");
  });

  it('touchmove on the dim area / header is swallowed; the list itself may pan', async () => {
    const h = await html('https://x/#t=x');
    expect(h).toMatch(/sheetBackdrop\.addEventListener\('touchmove', \(e\) => \{\s*if \(!\(sheetList\.contains && sheetList\.contains\(e\.target\)\)\) e\.preventDefault\(\);\s*\}, \{ passive: false \}\);/);
  });

  it('overlay page carries none of the sheet CSS', async () => {
    const h = await html('https://x/overlay?t=x');
    expect(h).not.toContain('sheet-open');
    expect(h).not.toContain('--sheet-bg');
  });
});
