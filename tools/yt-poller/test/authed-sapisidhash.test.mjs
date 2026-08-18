import { describe, it, expect } from 'vitest';
import {
  computeSapisidHash,
  buildSapisidHashHeader,
  parseCookieFile,
  extractSapisid,
  serializeCookieHeader,
  SAPISIDHASH_ORIGIN,
} from '../authed/sapisidhash.mjs';

describe('computeSapisidHash', () => {
  it('matches a hand-computed vector (SHA1 of "ts sapisid origin", independently verified via `shasum -a 1`)', () => {
    // printf '%s' "1700000000 abcdef1234567890 https://www.youtube.com" | shasum -a 1
    //   => 0129a7f32d4b52d4285af89b0288ba21792abcb0
    const hash = computeSapisidHash(1700000000, 'abcdef1234567890', 'https://www.youtube.com');
    expect(hash).toBe('0129a7f32d4b52d4285af89b0288ba21792abcb0');
  });

  it('defaults origin to https://www.youtube.com', () => {
    const withDefault = computeSapisidHash(1700000000, 'abcdef1234567890');
    const explicit = computeSapisidHash(1700000000, 'abcdef1234567890', SAPISIDHASH_ORIGIN);
    expect(withDefault).toBe(explicit);
    expect(withDefault).toBe('0129a7f32d4b52d4285af89b0288ba21792abcb0');
  });

  it('produces a different hash for a different origin', () => {
    const hash = computeSapisidHash(1700000000, 'abcdef1234567890', 'https://example.com');
    expect(hash).not.toBe('0129a7f32d4b52d4285af89b0288ba21792abcb0');
  });
});

describe('buildSapisidHashHeader', () => {
  it('formats as "SAPISIDHASH <ts>_<hash>" using the injected clock', () => {
    const header = buildSapisidHashHeader('abcdef1234567890', { now: () => 1700000000 });
    expect(header).toBe('SAPISIDHASH 1700000000_0129a7f32d4b52d4285af89b0288ba21792abcb0');
  });

  it('recomputes the hash when the injected clock changes', () => {
    const h1 = buildSapisidHashHeader('abcdef1234567890', { now: () => 1700000000 });
    const h2 = buildSapisidHashHeader('abcdef1234567890', { now: () => 1700000001 });
    expect(h1).not.toBe(h2);
    expect(h2.startsWith('SAPISIDHASH 1700000001_')).toBe(true);
  });
});

describe('parseCookieFile', () => {
  it('parses Netscape/Mozilla cookie-jar format (7 tab-separated fields)', () => {
    const content = [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSAPISID\tabc123secret',
      '.youtube.com\tTRUE\t/\tTRUE\t1999999999\t__Secure-3PAPISID\tabc123secret',
    ].join('\n');
    const cookies = parseCookieFile(content);
    expect(cookies.SAPISID).toBe('abc123secret');
    expect(cookies['__Secure-3PAPISID']).toBe('abc123secret');
  });

  it('skips comments and blank lines in Netscape format', () => {
    const content = '# comment\n\n.youtube.com\tTRUE\t/\tTRUE\t1\tFOO\tbar\n';
    expect(parseCookieFile(content)).toEqual({ FOO: 'bar' });
  });

  it('parses a flat JSON object of name: value pairs', () => {
    const content = JSON.stringify({ SAPISID: 'jsonsecret', OTHER: 'x' });
    expect(parseCookieFile(content)).toEqual({ SAPISID: 'jsonsecret', OTHER: 'x' });
  });

  it('parses a JSON array of {name, value} objects (browser-extension export shape)', () => {
    const content = JSON.stringify([
      { name: 'SAPISID', value: 'arraysecret', domain: '.youtube.com' },
      { name: 'OTHER', value: 'x' },
    ]);
    expect(parseCookieFile(content)).toEqual({ SAPISID: 'arraysecret', OTHER: 'x' });
  });

  it('returns {} for empty content', () => {
    expect(parseCookieFile('')).toEqual({});
    expect(parseCookieFile('   \n  ')).toEqual({});
  });
});

describe('extractSapisid', () => {
  it('prefers plain SAPISID when both are present', () => {
    expect(extractSapisid({ SAPISID: 'a', '__Secure-3PAPISID': 'b' })).toBe('a');
  });

  it('falls back to __Secure-3PAPISID when SAPISID is absent', () => {
    expect(extractSapisid({ '__Secure-3PAPISID': 'b' })).toBe('b');
  });

  it('returns null when neither cookie is present', () => {
    expect(extractSapisid({ OTHER: 'x' })).toBeNull();
    expect(extractSapisid({})).toBeNull();
  });
});

describe('serializeCookieHeader', () => {
  it('joins cookies as "name=value; name2=value2"', () => {
    expect(serializeCookieHeader({ A: '1', B: '2' })).toBe('A=1; B=2');
  });

  it('returns empty string for no cookies', () => {
    expect(serializeCookieHeader({})).toBe('');
  });
});
