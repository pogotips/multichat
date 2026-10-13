import { describe, it, expect } from 'vitest';
import { stripEmoteRanges } from '../src/lib.js';

describe('stripEmoteRanges', () => {
  it('removes Twitch emote ranges on ASCII text (end inclusive)', () => {
    expect(stripEmoteRanges('hello Kappa world', [{ id: '25', start: 6, end: 10 }])).toBe('hello world');
  });
  it('uses code-point offsets for YouTube text with emoji', () => {
    expect(stripEmoteRanges('😀 hi 😀', [{ start: 0, end: 0 }, { start: 5, end: 5 }])).toBe('hi');
  });
  it('ignores malformed entries', () => {
    const bad = [null, {}, { start: 'a', end: 2 }, { start: 3, end: 1 }, { start: -1, end: 2 }, { start: 0, end: 99 }, { start: 1.5, end: 2 }];
    expect(stripEmoteRanges('keep me', bad)).toBe('keep me');
  });
  it('returns empty when everything is an emote', () => {
    expect(stripEmoteRanges('Kappa', [{ start: 0, end: 4 }])).toBe('');
  });
  it('tolerates undefined emotes and gifs and non-string text', () => {
    expect(stripEmoteRanges('plain', undefined, undefined)).toBe('plain');
    expect(stripEmoteRanges(undefined)).toBe('');
    expect(stripEmoteRanges('x', 'nope', 5)).toBe('x');
  });
  it('also removes gif ranges', () => {
    expect(stripEmoteRanges('look [GIF] here', [], [{ start: 5, end: 9, id: 'g' }])).toBe('look here');
  });
});
