// VERIFIED author badge: stock parser sets item.isVerified; normalize.mjs
// forwards it as msg.verified (strict true only).
import { describe, it, expect } from 'vitest';
import { parseOne } from './helpers/envelope.mjs';
import { normalizeChatItem } from '../normalize.mjs';
import customEmojiMessage from './fixtures/custom-emoji-message.json';

function withBadges(badges) {
  const f = JSON.parse(JSON.stringify(customEmojiMessage));
  if (badges) f.liveChatTextMessageRenderer.authorBadges = badges;
  return f;
}
const verifiedBadge = { liveChatAuthorBadgeRenderer: { icon: { iconType: 'VERIFIED' }, tooltip: 'Verified' } };
const modBadge = { liveChatAuthorBadgeRenderer: { icon: { iconType: 'MODERATOR' }, tooltip: 'Moderator' } };

describe('verified badge', () => {
  it('VERIFIED badge -> item.isVerified -> msg.verified', () => {
    const item = parseOne(withBadges([verifiedBadge]));
    expect(item.isVerified).toBe(true);
    expect(normalizeChatItem(item).verified).toBe(true);
  });
  it('no badge -> no verified key', () => {
    expect(normalizeChatItem(parseOne(withBadges(null)))).not.toHaveProperty('verified');
  });
  it('MODERATOR alone -> isMod, no verified key', () => {
    const msg = normalizeChatItem(parseOne(withBadges([modBadge])));
    expect(msg.isMod).toBe(true);
    expect(msg).not.toHaveProperty('verified');
  });
});
