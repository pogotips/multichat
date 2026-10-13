import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';

const env = { MULTICHAT_VIEW_SECRET: 'x' };

async function html(url) {
  const res = await worker.fetch(new Request(url), env, {});
  expect(res.status).toBe(200);
  return res.text();
}

describe('PWA name-tap page', () => {
  it('has sheet markup, pointer cursor, helpers and wiring', async () => {
    const h = await html('https://x/#t=x');
    for (const id of ['sheetBackdrop', 'sheetClose', 'sheetList', 'sheetTitle']) expect(h).toContain('id="' + id + '"');
    // pointer cursor is feed-scoped since 2026-10-12 (sheet rows are not tappable)
    const rule = h.match(/#feed \.user \{[^}]*\}/);
    expect(rule && rule[0]).toContain('cursor: pointer');
    expect(h).toContain('function userKeyOf(');
    expect(h).toContain('function createMessageStore(');
    expect(h).toContain('msgStore.push(msg)');
    expect(h).toContain('msgStore.applyMark(m)');
    expect(h).toContain("feed.addEventListener('click'");
  });
  it('overlay page has none of it', async () => {
    const h = await html('https://x/overlay?t=x');
    expect(h).not.toContain('sheetBackdrop');
    expect(h).not.toContain('createMessageStore');
  });
});
