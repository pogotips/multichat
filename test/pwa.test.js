import { describe, it, expect } from 'vitest';
import worker, { resolveToken } from '../src/worker.js';

const env = { MULTICHAT_VIEW_SECRET: 'x' };

describe('GET /manifest.webmanifest', () => {
  it('200, correct content-type, valid JSON, expected icons', async () => {
    const res = await worker.fetch(new Request('https://x/manifest.webmanifest'), env, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    const body = await res.json();
    expect(body.name).toBe('Multichat');
    expect(body.start_url).toBe('/');
    const sizes = body.icons.map((i) => i.sizes + ':' + i.purpose);
    expect(sizes).toContain('192x192:any');
    expect(sizes).toContain('512x512:any');
    expect(sizes).toContain('512x512:maskable');
  });
});

describe('icon routes', () => {
  it('serve PNG with long-cache headers', async () => {
    for (const path of ['/icon-180.png', '/icon-192.png', '/icon-512.png']) {
      const res = await worker.fetch(new Request('https://x' + path), env, {});
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    }
  });
});

describe('GET /favicon.ico', () => {
  it('200, image/png, 1-day cache — unauthenticated, no ?t= needed', async () => {
    const res = await worker.fetch(new Request('https://x/favicon.ico'), {}, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic bytes — proves it's a real decoded image, not an empty/garbled body.
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe('<link rel="icon"> present on every served page', () => {
  it('PWA (GET /)', async () => {
    const res = await worker.fetch(new Request('https://x/'), env, {});
    const html = await res.text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico">');
  });

  it('/overlay', async () => {
    const overlayEnv = { ...env, MULTICHAT_OVERLAY_SECRET: 'y' };
    const res = await worker.fetch(new Request('https://x/overlay?t=y'), overlayEnv, {});
    const html = await res.text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico">');
  });

  it('/overlay/config', async () => {
    const overlayEnv = { ...env, MULTICHAT_OVERLAY_SECRET: 'y' };
    const res = await worker.fetch(new Request('https://x/overlay/config?t=y'), overlayEnv, {});
    const html = await res.text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico">');
  });
});

describe('resolveToken', () => {
  it('fragment present, no storage — persists fragment', () => {
    expect(resolveToken({ fragmentToken: 'abc', storedToken: null }))
      .toEqual({ token: 'abc', action: 'persist' });
  });

  it('fragment present, stale storage — fragment wins, persists', () => {
    expect(resolveToken({ fragmentToken: 'new', storedToken: 'old' }))
      .toEqual({ token: 'new', action: 'persist' });
  });

  it('fragment absent, storage present — uses storage, no persist', () => {
    expect(resolveToken({ fragmentToken: null, storedToken: 'saved' }))
      .toEqual({ token: 'saved', action: 'none' });
  });

  it('neither present — prompt', () => {
    expect(resolveToken({ fragmentToken: null, storedToken: null }))
      .toEqual({ token: null, action: 'prompt' });
  });
});
