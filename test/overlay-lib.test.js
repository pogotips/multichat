// Pure-function coverage for the OBS-overlay feature's lib.js additions:
// the spoken-body sanitize pipeline, the mod-action queue-drop predicate,
// and the overlay param validator (shared by /overlay and /overlay/config —
// see OVERLAY_PARAM_SPEC's own header comment for why one spec, not two).
import { describe, it, expect } from 'vitest';
import {
  stripControlChars, stripUrls, collapseRepeatedChars, sanitizeSpokenBody,
  markMatchesQueueItem, OVERLAY_PARAM_SPEC, validateOverlayParam, validateOverlayConfig,
} from '../src/lib.js';
import { formatOverlayUtterance } from '../src/worker.js';

describe('stripControlChars', () => {
  it('removes ASCII control chars, leaves ordinary text untouched', () => {
    expect(stripControlChars('hi\x00there\x1F!\x7F')).toBe('hithere!');
    expect(stripControlChars('plain text')).toBe('plain text');
  });
});

describe('stripUrls', () => {
  it('removes an http(s) URL', () => {
    expect(stripUrls('check this out https://example.com/x collapse')).toBe('check this out collapse');
  });

  it('removes a bare www. URL', () => {
    expect(stripUrls('go to www.example.com now')).toBe('go to now');
  });

  it('leaves text with no URL untouched', () => {
    expect(stripUrls('no links here')).toBe('no links here');
  });
});

describe('collapseRepeatedChars', () => {
  it('collapses a long repeated run to 3', () => {
    expect(collapseRepeatedChars('soooooo good')).toBe('sooo good');
  });

  it('leaves a short repeat (<=3) untouched', () => {
    expect(collapseRepeatedChars('yesss')).toBe('yesss');
  });
});

describe('sanitizeSpokenBody', () => {
  it('runs the full pipeline: control chars -> URLs -> collapse -> mentions -> cap', () => {
    const out = sanitizeSpokenBody('hey @Jon\x00 soooo hyped https://example.com/x !!!');
    expect(out).toBe('hey Jon sooo hyped !!!');
  });

  it('caps the body at 120 chars, separate from and before the whole-utterance cap', () => {
    // Alternating chars, not a single repeated run — a uniform 'x'.repeat(N)
    // fixture would get shortened by collapseRepeatedChars first and never
    // actually exercise the length cap.
    const long = 'ab'.repeat(100); // 200 chars
    expect(sanitizeSpokenBody(long).length).toBe(120);
  });

  it('returns empty string, never throws, for a message that was only a URL', () => {
    expect(sanitizeSpokenBody('https://example.com/only-a-link')).toBe('');
  });

  it('empty/falsy input returns empty string', () => {
    expect(sanitizeSpokenBody('')).toBe('');
    expect(sanitizeSpokenBody(undefined)).toBe('');
  });
});

describe('formatOverlayUtterance', () => {
  const financialMsg = { user: 'baller', kind: 'cheer', amount: '500 bits', text: 'hey @Jon thanks!!! https://x.com' };

  it('speakBody:false matches formatUtterance exactly (today\'s PWA behavior)', () => {
    expect(formatOverlayUtterance(financialMsg, { speakBody: false })).toBe('baller, cheer, 500 bits');
  });

  it('speakBody:true appends the sanitized body', () => {
    expect(formatOverlayUtterance(financialMsg, { speakBody: true })).toBe('baller, cheer, 500 bits, hey Jon thanks!!!');
  });

  it('a body that sanitizes to empty degrades to the base line, not a broken utterance', () => {
    const urlOnly = { ...financialMsg, text: 'https://example.com/only-a-link' };
    expect(formatOverlayUtterance(urlOnly, { speakBody: true })).toBe('baller, cheer, 500 bits');
  });

  it('speakBody:true with no msg.text at all is a no-op (base line only)', () => {
    const noText = { user: 'baller', kind: 'cheer', amount: '500 bits' };
    expect(formatOverlayUtterance(noText, { speakBody: true })).toBe('baller, cheer, 500 bits');
  });
});

describe('markMatchesQueueItem', () => {
  it('delete/twitch matches on twId', () => {
    expect(markMatchesQueueItem({ action: 'delete', targetId: 'tw1' }, { twId: 'tw1' })).toBe(true);
    expect(markMatchesQueueItem({ action: 'delete', targetId: 'tw1' }, { twId: 'tw2' })).toBe(false);
  });

  it('delete/yt matches on ytId, not twId', () => {
    expect(markMatchesQueueItem({ action: 'delete', platform: 'yt', targetId: 'yt1' }, { ytId: 'yt1' })).toBe(true);
    expect(markMatchesQueueItem({ action: 'delete', platform: 'yt', targetId: 'yt1' }, { twId: 'yt1' })).toBe(false);
  });

  it('author_delete matches on authorId', () => {
    expect(markMatchesQueueItem({ action: 'author_delete', authorId: 'auth1' }, { authorId: 'auth1' })).toBe(true);
    expect(markMatchesQueueItem({ action: 'author_delete', authorId: 'auth1' }, { authorId: 'auth2' })).toBe(false);
  });

  it('supersede matches on twId (gigantify double-display case)', () => {
    expect(markMatchesQueueItem({ action: 'supersede', targetId: 'tw9' }, { twId: 'tw9' })).toBe(true);
  });

  it('unrecognized action (timeout/ban) falls back to login', () => {
    expect(markMatchesQueueItem({ action: 'timeout', login: 'baduser' }, { login: 'baduser' })).toBe(true);
    expect(markMatchesQueueItem({ action: 'ban', login: 'baduser' }, { login: 'otheruser' })).toBe(false);
  });

  it('missing identity fields never match (no false positive from two undefineds)', () => {
    expect(markMatchesQueueItem({ action: 'delete' }, {})).toBe(false);
    expect(markMatchesQueueItem({ action: 'timeout' }, {})).toBe(false);
  });
});

describe('validateOverlayParam', () => {
  it('valid hex color passes through', () => {
    expect(validateOverlayParam('bg', '#123abc')).toEqual({ value: '#123abc', rejected: false });
  });

  it('invalid color (named, short hex, injection attempt) falls back to default and is flagged rejected', () => {
    expect(validateOverlayParam('bg', 'red')).toEqual({ value: OVERLAY_PARAM_SPEC.bg.default, rejected: true });
    expect(validateOverlayParam('bg', '#fff')).toEqual({ value: OVERLAY_PARAM_SPEC.bg.default, rejected: true });
    expect(validateOverlayParam('bg', '#fff"><script>')).toEqual({ value: OVERLAY_PARAM_SPEC.bg.default, rejected: true });
  });

  it('valid enum passes through, invalid enum falls back', () => {
    expect(validateOverlayParam('font', 'mono')).toEqual({ value: 'mono', rejected: false });
    expect(validateOverlayParam('font', 'Comic Sans MS')).toEqual({ value: OVERLAY_PARAM_SPEC.font.default, rejected: true });
  });

  it('int within range passes through, out-of-range/non-integer falls back', () => {
    expect(validateOverlayParam('fontSize', '40')).toEqual({ value: 40, rejected: false });
    expect(validateOverlayParam('fontSize', '999')).toEqual({ value: OVERLAY_PARAM_SPEC.fontSize.default, rejected: true });
    expect(validateOverlayParam('fontSize', '0')).toEqual({ value: OVERLAY_PARAM_SPEC.fontSize.default, rejected: true });
    expect(validateOverlayParam('fontSize', '12.5')).toEqual({ value: OVERLAY_PARAM_SPEC.fontSize.default, rejected: true });
    expect(validateOverlayParam('fontSize', 'nope')).toEqual({ value: OVERLAY_PARAM_SPEC.fontSize.default, rejected: true });
  });

  it('maxRows/rowTtlSec boundary values', () => {
    expect(validateOverlayParam('maxRows', '5')).toEqual({ value: 5, rejected: false });
    expect(validateOverlayParam('maxRows', '100')).toEqual({ value: 100, rejected: false });
    expect(validateOverlayParam('maxRows', '4')).toEqual({ value: OVERLAY_PARAM_SPEC.maxRows.default, rejected: true });
    expect(validateOverlayParam('maxRows', '101')).toEqual({ value: OVERLAY_PARAM_SPEC.maxRows.default, rejected: true });
    expect(validateOverlayParam('rowTtlSec', '0')).toEqual({ value: 0, rejected: false });
    expect(validateOverlayParam('rowTtlSec', '600')).toEqual({ value: 600, rejected: false });
  });

  it('absent param (null) uses default, NOT flagged as a rejection', () => {
    expect(validateOverlayParam('bg', null)).toEqual({ value: OVERLAY_PARAM_SPEC.bg.default, rejected: false });
  });

  it('unknown key returns undefined value, not rejected (caller should not iterate unknown keys anyway)', () => {
    expect(validateOverlayParam('notARealParam', 'x')).toEqual({ value: undefined, rejected: false });
  });

  it('ttsBody defaults off', () => {
    expect(OVERLAY_PARAM_SPEC.ttsBody.default).toBe('off');
    expect(validateOverlayParam('ttsBody', null)).toEqual({ value: 'off', rejected: false });
    expect(validateOverlayParam('ttsBody', 'on')).toEqual({ value: 'on', rejected: false });
  });

  // gifAlt on (default) keeps the overlay's GIF rows on alt text only — a
  // public broadcast surface stays opt-in, not opt-out, same posture as
  // ttsBody above. The PWA never reads this param at all, so its default-on
  // image render is unaffected regardless of this flag's value.
  it('gifAlt defaults on', () => {
    expect(OVERLAY_PARAM_SPEC.gifAlt.default).toBe('on');
    expect(validateOverlayParam('gifAlt', null)).toEqual({ value: 'on', rejected: false });
    expect(validateOverlayParam('gifAlt', 'off')).toEqual({ value: 'off', rejected: false });
  });
});

describe('validateOverlayConfig', () => {
  it('validates every spec key in one pass and reports only actual rejections', () => {
    const params = new URLSearchParams({ bg: '#111111', fontSize: '999', maxRows: '20' });
    const { config, rejections } = validateOverlayConfig(params);
    expect(config.bg).toBe('#111111');
    expect(config.fontSize).toBe(OVERLAY_PARAM_SPEC.fontSize.default); // rejected, fell back
    expect(config.maxRows).toBe(20);
    expect(config.tts).toBe(OVERLAY_PARAM_SPEC.tts.default); // absent, default, not a rejection
    expect(rejections).toEqual([{ key: 'fontSize', raw: '999' }]);
  });

  it('an empty params object produces an all-default config with zero rejections', () => {
    const { config, rejections } = validateOverlayConfig(new URLSearchParams());
    for (const key of Object.keys(OVERLAY_PARAM_SPEC)) {
      expect(config[key]).toBe(OVERLAY_PARAM_SPEC[key].default);
    }
    expect(rejections).toEqual([]);
  });
});
