// A real YouTube verified tick must be visibly distinct from a check mark
// typed into a display name (2026-10-12). The real tick is an EMPTY
// span.verified drawn by CSS (`.verified::before` inside a filled round
// badge); a typed "✓" stays plain name text in the user span's text node,
// gets no element, no badge, and inherits the name color. Display names are
// never rewritten. Holds on the PWA, the overlay and the config preview,
// which all share buildRow.
import { describe, it, expect } from 'vitest';
import worker, { roleClass } from '../src/worker.js';
import { buildRow } from '../src/lib.js';
import { createFakeDocument, serializeNode, FakeElement } from './helpers/fake-doc.js';

// fake-doc has no setAttribute (buildRow guards for it); this variant records
// attributes so the a11y attributes on the badge can be asserted.
function createRecordingDocument() {
  const doc = createFakeDocument();
  return {
    ...doc,
    createElement: (tag) => {
      const el = new FakeElement(tag);
      el.attrs = {};
      el.setAttribute = (k, v) => { el.attrs[k] = v; };
      return el;
    },
  };
}

const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };

function userSpan(msg) {
  const row = buildRow(msg, { myName: '', roleClass, doc: createFakeDocument(), mention: true });
  return row.children.find((c) => c.className && c.className.split(' ').includes('user'));
}
const yt = (extra) => ({ platform: 'yt', user: 'Name', text: 'hi', ...extra });

describe('verified tick cannot be spoofed by a typed check mark', () => {
  it('real tick: an empty span.verified, no text glyph; copyable text is just "Name:"', () => {
    const u = userSpan(yt({ verified: true }));
    const tick = u.children.find((c) => c.nodeType === 'element');
    expect(tick.className).toBe('verified');
    expect(tick.children).toHaveLength(0);
    expect(tick.textContent).toBe('');
    expect(tick.title).toBe('Verified channel');
    expect(u.textContent).toBe('Name:');
    expect(serializeNode(u).children).toEqual([{ text: 'Name' }, { tag: 'span', className: 'verified' }, { text: ':' }]);
  });

  it('badge is announced: role="img" + aria-label when the doc supports attributes; no throw when it does not', () => {
    const row = buildRow(yt({ verified: true }), { myName: '', roleClass, doc: createRecordingDocument(), mention: true });
    const u = row.children.find((c) => c.className && c.className.split(' ').includes('user'));
    const tick = u.children.find((c) => c.nodeType === 'element');
    expect(tick.attrs).toEqual({ role: 'img', 'aria-label': 'Verified channel' });
    expect(() => userSpan(yt({ verified: true }))).not.toThrow(); // plain fake doc, no setAttribute
  });

  it('a typed ✓ in a display name stays plain text: no element, name untouched', () => {
    const u = userSpan(yt({ user: 'Name ✓' }));
    expect(serializeNode(u).children).toEqual([{ text: 'Name ✓:' }]);
    expect(u.children.some((c) => c.nodeType === 'element')).toBe(false);
  });

  it('a typed ✓ on a verified account: name text keeps the glyph, the badge is still the only element', () => {
    const u = userSpan(yt({ user: 'Name ✓', verified: true }));
    expect(serializeNode(u).children).toEqual([{ text: 'Name ✓' }, { tag: 'span', className: 'verified' }, { text: ':' }]);
  });
});

describe('.verified is a CSS-drawn badge on every page', () => {
  it.each(['https://x/#t=x', 'https://x/overlay?t=y', 'https://x/overlay/config?t=y'])('%s', async (url) => {
    const res = await worker.fetch(new Request(url), env, {});
    expect(res.status).toBe(200);
    const h = await res.text();
    const rule = h.match(/\.verified \{[^}]*\}/);
    expect(rule && rule[0]).toContain('border-radius: 50%');
    expect(rule && rule[0]).toContain('background:');
    expect(h).toMatch(/\.verified::before \{ content: "\\2713"; \}/);
  });
});
