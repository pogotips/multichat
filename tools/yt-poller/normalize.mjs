// Pure normalization of youtube-chat ChatItems into the Worker's ingest
// shape ({ user, text, kind?, amount?, isMod?, isMember?, ytId?, authorId?,
// emotes? }). No network, no env — kept separate from poller.mjs so it's
// unit-testable.

export const KIND_FALLBACK_TEXT = {
  superchat: 'Super Chat',
  supersticker: 'Super Sticker',
  member_new: 'New member',
  member_milestone: 'Membership milestone',
  member_gift: 'Gifted memberships',
  member_gift_received: 'Received a gift membership',
  yt_gift: 'Sent a gift',
};

// Cap on custom-emoji entries per message — matches the worker's own cap in
// sanitizeYtEmotes (src/worker.js); enforced here too so a message with more
// never even makes it into the POST body.
const MAX_EMOTES = 20;

// Builds text + emotes in one pass over item.message, tracking the running
// offset in Unicode CODE POINTS (via [...str].length), never UTF-16 code
// units (.length) — must match the client's [...text] walker exactly (see
// renderText in src/worker.js) or astral/CJK/ZWJ-sequence text before a
// custom emoji desyncs the image position. Standard (non-custom) emoji
// contribute only emojiText to the string, no emotes entry. Only meaningful
// for plain-message text — callers must not use this on header-prefixed
// finalText (member/gift kinds), where custom emojis don't occur and offsets
// wouldn't match the reshaped string.
//
// Offsets are tracked against the UNTRIMMED joined text, then shifted by
// however many leading code points .trim() removes — computing them against
// the final (post-trim) string directly would desync every emote position
// whenever the message starts with whitespace.
function buildTextAndEmotes(parts) {
  let rawText = '';
  const rawEmotes = [];
  let cpOffset = 0;
  for (const part of parts) {
    const chunk = part.text ?? part.emojiText ?? '';
    if (part.isCustomEmoji && part.url && rawEmotes.length < MAX_EMOTES) {
      const len = [...chunk].length;
      rawEmotes.push({ start: cpOffset, end: cpOffset + len - 1, url: part.url, alt: part.alt });
    }
    rawText += chunk;
    cpOffset += [...chunk].length;
  }
  const text = rawText.trim();
  if (!rawEmotes.length) return { text, emotes: [] };
  const leadingTrimmed = [...rawText].length - [...rawText.trimStart()].length;
  const textLen = [...text].length;
  const emotes = [];
  for (const e of rawEmotes) {
    const start = e.start - leadingTrimmed;
    const end = e.end - leadingTrimmed;
    if (start < 0 || end >= textLen) continue; // fell inside trimmed whitespace — shouldn't happen, guard anyway
    emotes.push({ start, end, url: e.url, alt: e.alt });
  }
  return { text, emotes };
}

export function normalizeChatItem(item) {
  const user = item.author?.name ?? 'unknown';
  const { text, emotes } = buildTextAndEmotes(item.message ?? []);

  // Membership money events are identified by renderer type, patched into
  // youtube-chat's parser (see patches/) as item.membership /
  // item.membershipGift / item.membershipGiftReceived — never by
  // item.isMembership, which just means "author wears a member badge" and is
  // true on every message from any existing member.
  //
  // member_gift = gifted *memberships* (classic sponsorship renderer,
  // liveChatSponsorshipsGiftPurchaseAnnouncementRenderer).
  // yt_gift = the newer paid Jewels/animated-gift feature
  // (giftMessageViewModel — a ViewModel, structurally different, no count
  // field). Two unrelated YouTube features that both read as "a gift" —
  // don't merge them.
  let kind;
  let amount;
  if (item.superchat) {
    kind = item.superchat.sticker ? 'supersticker' : 'superchat';
    amount = item.superchat.amount;
  } else if (item.giftMessage) {
    kind = 'yt_gift';
    amount = item.giftMessage.giftName;
  } else if (item.membershipGift) {
    kind = 'member_gift';
    const n = item.membershipGift.count;
    amount = n === 1 ? '1 gift' : `${n} gifts`;
  } else if (item.membershipGiftReceived) {
    kind = 'member_gift_received';
  } else if (item.membership) {
    kind = item.membership.milestone ? 'member_milestone' : 'member_new';
  }

  let finalText = text;
  if (kind === 'member_milestone') {
    // header = "Member for N months"; text = the member's optional comment
    const header = item.membership.headerText;
    finalText = header && text ? `${header} — ${text}` : header || text;
  } else if (kind === 'member_new') {
    // text already carries headerSubtext ("Welcome to X!") when it has runs
    finalText = text || item.membership.headerText;
  } else if (kind === 'member_gift') {
    finalText = text || item.membershipGift.headerText;
  }
  finalText = finalText || (kind ? KIND_FALLBACK_TEXT[kind] : '');
  if (!finalText) return null;

  const msg = { user, text: finalText };
  if (item.id) msg.ytId = item.id;
  if (kind) msg.kind = kind;
  if (amount) msg.amount = amount;
  if (item.isModerator || item.isOwner) msg.isMod = true;
  if (item.isMembership) msg.isMember = true;
  if (item.author?.channelId) msg.authorId = item.author.channelId;
  // Only attach emotes when finalText is exactly the plain-message text —
  // member_milestone concatenates a header ("Member for N months — ..."),
  // which would desync every offset computed against the un-prefixed text.
  // member_new/member_gift fall back to a headerText only when text was
  // empty, in which case emotes is already empty (no message parts at all).
  if (emotes.length && finalText === text) msg.emotes = emotes;
  return msg;
}
