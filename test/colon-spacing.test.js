import { describe, it, expect } from 'vitest';
import worker, { roleClass } from '../src/worker.js';
import { buildRow } from '../src/lib.js';
import { createFakeDocument } from './helpers/fake-doc.js';

const env = { MULTICHAT_VIEW_SECRET: 'x' };

async function html(url) {
  const res = await worker.fetch(new Request(url), env, {});
  expect(res.status).toBe(200);
  return res.text();
}

describe('colon spacing', () => {
  it('PWA .user rule has margin-right: 4px', async () => {
    const h = await html('https://x/#t=x');
    const rule = h.match(/\.user \{[^}]*\}/);
    expect(rule && rule[0]).toContain('margin-right: 4px');
  });
  it('overlay .user rule has margin-right: 4px', async () => {
    const h = await html('https://x/overlay?t=x');
    const rule = h.match(/\.user \{[^}]*\}/);
    expect(rule && rule[0]).toContain('margin-right: 4px');
  });
  it('buildRow user text is exactly "viewer1:" with no space', () => {
    const row = buildRow({ platform: 'tw', user: 'viewer1', text: 'hi' }, { myName: '', roleClass, doc: createFakeDocument(), mention: true });
    const user = row.children.find((c) => c.className && c.className.split(' ').includes('user'));
    expect(user.textContent).toBe('viewer1:');
  });
});
