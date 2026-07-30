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
