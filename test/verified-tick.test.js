import { describe, it, expect } from 'vitest';
import worker, { roleClass, normalizeYt } from '../src/worker.js';
import { buildRow } from '../src/lib.js';
import { createFakeDocument, serializeNode } from './helpers/fake-doc.js';

const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };

function userChildren(msg) {
  const row = buildRow(msg, { myName: '', roleClass, doc: createFakeDocument(), mention: true });
  const user = row.children.find((c) => c.className && c.className.split(' ').includes('user'));
  return serializeNode(user).children;
}
const yt = (extra) => ({ platform: 'yt', user: 'Name', text: 'hi', ...extra });

describe('buildRow verified tick', () => {
  it('verified yt msg gets a tick span after the name', () => {
    expect(userChildren(yt({ verified: true }))).toEqual([
      { text: 'Name' },
      // empty element: the glyph is CSS (.verified::before), never text —
      // see verified-tick-spoof.test.js (2026-10-12)
      { tag: 'span', className: 'verified' },
      { text: ':' },
    ]);
  });
  it('non-verified keeps the single text node', () => {
    expect(userChildren(yt({}))).toEqual([{ text: 'Name:' }]);
  });
  it('non-boolean verified values get no tick', () => {
    expect(userChildren(yt({ verified: 'yes' }))).toEqual([{ text: 'Name:' }]);
    expect(userChildren(yt({ verified: 1 }))).toEqual([{ text: 'Name:' }]);
  });
});

describe('normalizeYt verified', () => {
  const base = { user: 'A', text: 'hi' };
  it('true passes through', () => expect(normalizeYt({ ...base, verified: true }).verified).toBe(true));
  it('false / string / number / absent drop the key', () => {
    for (const v of [false, 'true', 1, undefined]) {
      const out = normalizeYt(v === undefined ? base : { ...base, verified: v });
      expect(out).not.toHaveProperty('verified');
    }
  });
});

describe('.verified CSS on all pages', () => {
  it.each(['https://x/#t=x', 'https://x/overlay?t=y', 'https://x/overlay/config?t=y'])('%s', async (url) => {
    const res = await worker.fetch(new Request(url), env, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('.verified {');
  });
});
