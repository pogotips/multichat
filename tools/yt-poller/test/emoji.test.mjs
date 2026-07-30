// Fixture-driven tests for custom-emoji offset computation in normalize.mjs —
// the code-point index semantics that must match the client's [...text]
// walker exactly (see renderText in src/worker.js). Standard (non-custom)
// emoji must stay text-only; a plain message must be byte-identical to
// pre-emoji-support behavior (regression guard).
import { describe, it, expect } from 'vitest';
import { parseChatData } from 'youtube-chat/dist/parser.js';
import { normalizeChatItem } from '../normalize.mjs';

import customEmojiMessage from './fixtures/custom-emoji-message.json';
import standardEmojiMessage from './fixtures/standard-emoji-message.json';
import multibyteCustomEmojiMessage from './fixtures/multibyte-custom-emoji-message.json';

function chatDataWith(...items) {
  return {
    continuationContents: {
      liveChatContinuation: {
        actions: items.map((item) => ({ addChatItemAction: { item, clientId: 'x' } })),
        continuations: [{ invalidationContinuationData: { continuation: 'next-token' } }],
      },
    },
  };
}

function parseOne(fixture) {
  const [chatItems] = parseChatData(chatDataWith(fixture));
  expect(chatItems).toHaveLength(1);
  return chatItems[0];
}

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
