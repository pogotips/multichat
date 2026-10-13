// Custom emoji picks the 48px thumbnail (patches/youtube-chat+2.2.0.patch,
// parseMessages), falling back to the first thumbnail. Static guard on the
// checked-in patch plus runtime checks through parseOne + normalizeChatItem.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOne } from './helpers/envelope.mjs';
import { normalizeChatItem } from '../normalize.mjs';
import customEmojiMessage from './fixtures/custom-emoji-message.json';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PATCH_SOURCE = fs.readFileSync(path.join(DIR, '..', 'patches', 'youtube-chat+2.2.0.patch'), 'utf8');

const W24 = 'https://yt3.ggpht.com/custom_smile=w24-h24-c-k-nd';
const W48 = 'https://yt3.ggpht.com/custom_smile=w48-h48-c-k-nd';

function withThumbs(thumbnails) {
  const f = JSON.parse(JSON.stringify(customEmojiMessage));
  const run = f.liveChatTextMessageRenderer.message.runs.find((r) => r.emoji);
  run.emoji.image.thumbnails = thumbnails;
  return f;
}

describe('patch text guard', () => {
  it('contains the 48px pick and still targets parser.js', () => {
    expect(PATCH_SOURCE).toContain('t.width === 48');
    expect(PATCH_SOURCE).toContain('--- a/node_modules/youtube-chat/dist/parser.js');
  });
});

describe('emoji thumbnail selection', () => {
  it('prefers the width-48 entry', () => {
    const msg = normalizeChatItem(parseOne(withThumbs([
      { url: W24, width: 24, height: 24 }, { url: W48, width: 48, height: 48 },
    ])));
    expect(msg.emotes[0].url).toBe(W48);
  });
  it('falls back to the first entry when no 48px exists', () => {
    const msg = normalizeChatItem(parseOne(withThumbs([{ url: W24, width: 24, height: 24 }])));
    expect(msg.emotes[0].url).toBe(W24);
  });
  it('matches a w48-h48 url when widths are absent', () => {
    const msg = normalizeChatItem(parseOne(withThumbs([{ url: W24 }, { url: W48 }])));
    expect(msg.emotes[0].url).toBe(W48);
  });
  it('empty thumbnails: url "" in the parsed part, no emotes key, no throw', () => {
    const item = parseOne(withThumbs([]));
    const part = item.message.find((p) => 'url' in p);
    expect(part.url).toBe('');
    let msg;
    expect(() => { msg = normalizeChatItem(item); }).not.toThrow();
    expect(msg).not.toHaveProperty('emotes');
  });
});
