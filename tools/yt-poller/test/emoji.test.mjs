// Fixture-driven tests for custom-emoji offset computation in normalize.mjs —
// the code-point index semantics that must match the client's [...text]
// walker exactly (see renderText in src/worker.js). Standard (non-custom)
// emoji must stay text-only; a plain message must be byte-identical to
// pre-emoji-support behavior (regression guard).
import { describe, it, expect } from 'vitest';
import { normalizeChatItem } from '../normalize.mjs';
import { parseOne } from './helpers/envelope.mjs';

import customEmojiMessage from './fixtures/custom-emoji-message.json';
import standardEmojiMessage from './fixtures/standard-emoji-message.json';
import multibyteCustomEmojiMessage from './fixtures/multibyte-custom-emoji-message.json';
import globalEmojiMessage from './fixtures/global-emoji-message.json';
import globalEmojiMissingImage from './fixtures/global-emoji-missing-image.json';

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
