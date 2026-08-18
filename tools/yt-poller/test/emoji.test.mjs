// Fixture-driven tests for custom-emoji offset computation in normalize.mjs —
// the code-point index semantics that must match the client's [...text]
// walker exactly (see renderText in src/worker.js). Standard (non-custom)
// emoji must stay text-only; a plain message must be byte-identical to
// pre-emoji-support behavior (regression guard).
import { describe, it, expect, vi } from 'vitest';
import { normalizeChatItem } from '../normalize.mjs';
import { parseOne } from './helpers/envelope.mjs';

import customEmojiMessage from './fixtures/custom-emoji-message.json';
import standardEmojiMessage from './fixtures/standard-emoji-message.json';
import multibyteCustomEmojiMessage from './fixtures/multibyte-custom-emoji-message.json';
import globalEmojiMessage from './fixtures/global-emoji-message.json';
import globalEmojiMissingImage from './fixtures/global-emoji-missing-image.json';
import globalEmojiMissingAlt from './fixtures/global-emoji-missing-alt.json';

describe('normalizeChatItem: custom emoji -> emotes', () => {
  it('a custom emoji mid-message produces a code-point-offset emotes entry', () => {
    const item = parseOne(customEmojiMessage);
    const msg = normalizeChatItem(item);
    expect(msg.text).toBe('gg :_smile: nice!');
    expect(msg.emotes).toEqual([
      { start: 3, end: 10, url: 'https://yt3.ggpht.com/custom_smile.png', alt: ':_smile:' },
    ]);
  });

  it('a standard (non-custom) emoji stays plain text, no emotes entry', () => {
    const item = parseOne(standardEmojiMessage);
    const msg = normalizeChatItem(item);
    expect(msg.text).toBe('nice 😀 stream');
    expect(msg.emotes).toBeUndefined();
  });

  it('forwards authorId from item.author.channelId', () => {
    const item = parseOne(customEmojiMessage);
    const msg = normalizeChatItem(item);
    expect(msg.authorId).toBe('UCemojifan0000000000000000');
  });
});

describe('normalizeChatItem: global (non-member) YouTube emoji -> emotes', () => {
  it('a global emoji (isCustomEmoji:false, PUA emojiId) mid-message produces a code-point-offset emotes entry', () => {
    const item = parseOne(globalEmojiMessage);
    const msg = normalizeChatItem(item);
    const shortcut = ':hand-pink-waving:';
    expect(msg.text).toBe(`hey ${shortcut} team`);
    const start = [...'hey '].length;
    const end = start + [...shortcut].length - 1;
    expect(msg.emotes).toEqual([
      { start, end, url: 'https://www.gstatic.com/youtube/img/emojis/emoji_u1f44b_pink.png', alt: shortcut },
    ]);
  });

  it('a global emoji with no image thumbnail falls back to its shortcut as plain text, no emotes entry', () => {
    const item = parseOne(globalEmojiMissingImage);
    const msg = normalizeChatItem(item);
    expect(msg.text).toBe('hey :hand-pink-waving: team');
    expect(msg.emotes).toBeUndefined();
  });

  // Pre-flagged MEDIUM (internal ship report, 2026-08-09): a global emoji
  // with an empty/missing shortcut (alt) used to fall back to its raw
  // emojiText — the unrenderable PUA codepoint — reintroducing the exact
  // tofu bug PR #42 fixed, specifically visible on the disallowed-host
  // degrade path (worker blanks the url, client renders the underlying
  // text span as-is). Proves the raw-codepoint leak no longer happens: the
  // text carries a safe placeholder instead, never a PUA codepoint.
  it('a global emoji with an empty shortcut (alt) falls back to a safe placeholder, never the raw PUA codepoint', () => {
    const item = parseOne(globalEmojiMissingAlt);
    const msg = normalizeChatItem(item);
    expect(msg.text).toBe('hey [emoji] team');
    expect(msg.text).not.toMatch(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u);
    const start = [...'hey '].length;
    const end = start + [...'[emoji]'].length - 1;
    expect(msg.emotes).toEqual([
      { start, end, url: 'https://www.gstatic.com/youtube/img/emojis/emoji_u1f44b_pink.png' },
    ]);
  });

  // Pins that isGlobalEmoji's PUA-codepoint regex is what discriminates —
  // not just isCustomEmoji:false + url present. A real Unicode-Consortium
  // emoji (emojiId "😀", non-PUA) with isCustomEmoji:false and an image URL
  // must still stay plain text: standardEmojiMessage's emojiId is a real
  // codepoint outside the PUA ranges, so isGlobalEmoji correctly returns
  // false even though every other signal matches a global emoji.
  it('a standard Unicode emoji (non-PUA emojiId, isCustomEmoji:false, image present) does not produce an emotes entry', () => {
    const item = parseOne(standardEmojiMessage);
    const msg = normalizeChatItem(item);
    expect(msg.text).toBe('nice 😀 stream');
    expect(msg.emotes).toBeUndefined();
  });
});

// yt_global_emoji_render: sampled debug visibility for the positive
// global/PUA-emoji render path (see GLOBAL_EMOJI_LOG_SAMPLE_RATE in
// normalize.mjs for the volume/cost reasoning). Math.random is mocked
// directly rather than looping for a statistical hit, since the rate itself
// isn't what these tests are pinning — the field shape and the "only global,
// never member-custom" scoping are.
function logEvents(spy, ev) {
  return spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0]);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.ev === ev);
}

// The patched parser's rendererFromAction does
// `run.emoji.image.thumbnails.shift()` / `authorPhoto.thumbnails.pop()` —
// genuine mutations of whatever object they're handed, not reads. Fixture
// JSON modules are imported once and shared by reference across every it()
// in this file, so a SECOND parseOne() call against the same imported
// fixture (globalEmojiMessage, customEmojiMessage — already exercised once
// each by the describe blocks above) gets an already-emptied thumbnails
// array, silently degrading part.url to '' (see parseThumbnailToImageItem).
// A JSON.parse(JSON.stringify(...)) clone taken now doesn't help — the
// shared singleton is already consumed by the time these tests run. These
// build independent renderer literals instead (same shape as
// fixtures/global-emoji-message.json and fixtures/custom-emoji-message.json)
// so each test gets an untouched thumbnails array of its own.
function freshGlobalEmojiRenderer() {
  return {
    liveChatTextMessageRenderer: {
      id: 'Chz-global-emoji-log-test-id',
      timestampUsec: '1752570270000000',
      authorExternalChannelId: 'UCglobalfan0000000000000',
      authorName: { simpleText: 'GlobalFan' },
      authorPhoto: { thumbnails: [{ url: 'https://yt4.ggpht.com/globalfan=s32', width: 32, height: 32 }] },
      message: {
        runs: [
          { text: 'hey ' },
          {
            emoji: {
              // A real Private-Use-Area codepoint, same as the captured
              // fixture (fixtures/global-emoji-message.json) — YouTube's own
              // global emoji are keyed by a PUA emojiId with no visible
              // glyph, which is genuinely a one-character string, not "".
              emojiId: '\u{E001}',
              shortcuts: [':hand-pink-waving:'],
              searchTerms: ['wave', 'hand'],
              isCustomEmoji: false,
              image: {
                thumbnails: [{ url: 'https://www.gstatic.com/youtube/img/emojis/emoji_u1f44b_pink.png', width: 24, height: 24 }],
                accessibility: { accessibilityData: { label: 'waving hand' } },
              },
            },
          },
          { text: ' team' },
        ],
      },
    },
  };
}

function freshCustomEmojiRenderer() {
  return {
    liveChatTextMessageRenderer: {
      id: 'Chz-custom-emoji-log-test-id',
      timestampUsec: '1752570240000000',
      authorExternalChannelId: 'UCemojifan0000000000000000',
      authorName: { simpleText: 'EmojiFan' },
      authorPhoto: { thumbnails: [{ url: 'https://yt4.ggpht.com/emojifan=s32', width: 32, height: 32 }] },
      message: {
        runs: [
          { text: 'gg ' },
          {
            emoji: {
              emojiId: 'UCtestchannel/custom_smile',
              shortcuts: [':_smile:'],
              searchTerms: ['smile'],
              isCustomEmoji: true,
              image: {
                thumbnails: [{ url: 'https://yt3.ggpht.com/custom_smile.png', width: 24, height: 24 }],
                accessibility: { accessibilityData: { label: 'smile' } },
              },
            },
          },
          { text: ' nice!' },
        ],
      },
    },
  };
}

// Same fresh-literal-renderer reasoning as freshGlobalEmojiRenderer/
// freshCustomEmojiRenderer above (shared fixture JSON gets its thumbnails
// array consumed by .shift()/.pop() on first use) — this one pins the
// intersection of two features that each have their own coverage but were
// never exercised together: PR #47's GLOBAL_EMOJI_PLACEHOLDER fallback
// (chunkText, for a global emoji with an empty/missing alt/shortcut) and PR
// #48's sampled yt_global_emoji_render debug log (buildTextAndEmotes). An
// empty shortcuts array, same as fixtures/global-emoji-missing-alt.json,
// makes the patched parser's parseMessages set part.alt to undefined.
function freshGlobalEmojiMissingAltRenderer() {
  return {
    liveChatTextMessageRenderer: {
      id: 'Chz-global-emoji-missing-alt-log-test-id',
      timestampUsec: '1752570280000000',
      authorExternalChannelId: 'UCglobalnoaltfan000000001',
      authorName: { simpleText: 'GlobalNoAltFan' },
      authorPhoto: { thumbnails: [{ url: 'https://yt4.ggpht.com/globalnoaltfan=s32', width: 32, height: 32 }] },
      message: {
        runs: [
          { text: 'hey ' },
          {
            emoji: {
              emojiId: '\u{E001}',
              shortcuts: [],
              searchTerms: ['wave', 'hand'],
              isCustomEmoji: false,
              image: {
                thumbnails: [{ url: 'https://www.gstatic.com/youtube/img/emojis/emoji_u1f44b_pink.png', width: 24, height: 24 }],
                accessibility: { accessibilityData: { label: 'waving hand' } },
              },
            },
          },
          { text: ' team' },
        ],
      },
    },
  };
}

describe('normalizeChatItem: yt_global_emoji_render sampled debug log', () => {
  it('below the sample threshold, logs the codepoint/alt/url for a rendered global emoji', () => {
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.001); // well under the 2% rate
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const item = parseOne(freshGlobalEmojiRenderer());
    normalizeChatItem(item);
    expect(logEvents(logSpy, 'yt_global_emoji_render')).toEqual([{
      ev: 'yt_global_emoji_render',
      emojiText: '\u{E001}',
      alt: ':hand-pink-waving:',
      url: 'https://www.gstatic.com/youtube/img/emojis/emoji_u1f44b_pink.png',
    }]);
    randSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('above the sample threshold, never logs', () => {
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5); // well over the 2% rate
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const item = parseOne(freshGlobalEmojiRenderer());
    normalizeChatItem(item);
    expect(logEvents(logSpy, 'yt_global_emoji_render')).toEqual([]);
    randSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('a member-custom emoji (not global/PUA) never logs yt_global_emoji_render, sampled or not', () => {
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.001);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const item = parseOne(freshCustomEmojiRenderer());
    normalizeChatItem(item);
    expect(logEvents(logSpy, 'yt_global_emoji_render')).toEqual([]);
    randSpy.mockRestore();
    logSpy.mockRestore();
  });

  // The intersection PR #47 and PR #48 never got tested together: a global
  // emoji with an empty/missing alt/shortcut (PR #47's GLOBAL_EMOJI_PLACEHOLDER
  // fallback) sampled into the debug log (PR #48). Confirms the log's `alt`
  // field carries the raw part.alt value (`undefined` here, since the patched
  // parser sets `alt: shortcuts[0]` off an empty array) through the log call
  // site's `?? null`, independent of the placeholder chunkText substitutes
  // into msg.text — the two features read the same part.alt but never collide.
  it('a global emoji with an empty shortcut (alt) both renders the [emoji] placeholder AND logs alt: null', () => {
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.001); // well under the 2% rate
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const item = parseOne(freshGlobalEmojiMissingAltRenderer());
    const msg = normalizeChatItem(item);
    expect(msg.text).toBe('hey [emoji] team');
    expect(msg.text).not.toMatch(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u);
    expect(logEvents(logSpy, 'yt_global_emoji_render')).toEqual([{
      ev: 'yt_global_emoji_render',
      emojiText: '\u{E001}',
      alt: null,
      url: 'https://www.gstatic.com/youtube/img/emojis/emoji_u1f44b_pink.png',
    }]);
    randSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('normalizeChatItem: multibyte offset round-trip (the index-semantics guard)', () => {
  it('an astral emoji + CJK char + ZWJ-sequence emoji preceding a custom emoji produce exact code-point offsets', () => {
    const item = parseOne(multibyteCustomEmojiMessage);
    const msg = normalizeChatItem(item);
    // 🎉 (1 cp) + 你好 (2 cp) + 👨‍👩‍👧‍👦 (7 cp: man,ZWJ,woman,ZWJ,girl,ZWJ,boy) = 10 cp before the custom emoji.
    const prefix = '🎉你好👨‍👩‍👧‍👦';
    expect([...prefix]).toHaveLength(10);
    expect(msg.text).toBe(prefix + ':_smile: nice!');
    expect(msg.emotes).toEqual([
      { start: 10, end: 17, url: 'https://yt3.ggpht.com/custom_smile.png', alt: ':_smile:' },
    ]);
    // Round-trip: slicing msg.text by these code-point offsets (client semantics)
    // must reproduce exactly the shortcode the emoji replaces.
    const cps = [...msg.text];
    const token = cps.slice(msg.emotes[0].start, msg.emotes[0].end + 1).join('');
    expect(token).toBe(':_smile:');
  });
});

describe('normalizeChatItem: plain-text regression (no emotes key at all)', () => {
  it('a plain-text message with no emoji runs returns byte-identical {user,text} — no emotes key', () => {
    const msg = normalizeChatItem({
      id: 'Chz-plain-text-message-id',
      author: { name: 'Someone', channelId: 'UCplain00000000000000000' },
      message: [{ text: 'hello world' }],
    });
    expect(msg).toEqual({
      user: 'Someone',
      text: 'hello world',
      ytId: 'Chz-plain-text-message-id',
      authorId: 'UCplain00000000000000000',
    });
    expect('emotes' in msg).toBe(false);
  });

  it('caps at 20 emote entries', () => {
    const parts = [];
    for (let i = 0; i < 25; i++) {
      parts.push({
        url: 'https://yt3.ggpht.com/e.png',
        alt: ':_e:',
        isCustomEmoji: true,
        emojiText: ':_e:',
      });
    }
    const msg = normalizeChatItem({
      id: 'Chz-many-emoji',
      author: { name: 'Someone', channelId: 'UCmany00000000000000000' },
      message: parts,
    });
    expect(msg.emotes.length).toBe(20);
  });
});
