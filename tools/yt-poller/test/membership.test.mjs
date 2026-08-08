// Fixture-driven tests for the patched youtube-chat parser (patches/) and
// normalize.mjs: each captured renderer JSON must flow through
// parseChatData → normalizeChatItem into the Worker's ingest shape.
//
// Runs under the multichat root's vitest (`npm test` in multichat/); imports
// resolve against tools/yt-poller/node_modules, so `npm install` here first.
import { describe, it, expect } from 'vitest';
import { parseChatData } from 'youtube-chat/dist/parser.js';
import { normalizeChatItem, KIND_FALLBACK_TEXT } from '../normalize.mjs';
import { actionData, actionDataWithTracking, chatDataWith, chatDataWithTracking, parseOne } from './helpers/envelope.mjs';

import membershipNew from './fixtures/membership-new.json';
import membershipMilestone from './fixtures/membership-milestone.json';
import membershipMilestoneNoMsg from './fixtures/membership-milestone-nomsg.json';
import giftPurchase from './fixtures/gift-purchase.json';
import giftRedemption from './fixtures/gift-redemption.json';
import unknownRenderer from './fixtures/unknown-renderer.json';
import giftMessage from './fixtures/gift-message.json';
import viewerEngagement from './fixtures/viewer-engagement.json';
import modeChangeSlowmode from './fixtures/mode-change-slowmode.json';
import modeChangeSubonly from './fixtures/mode-change-subonly.json';

describe('patched parser: liveChatMembershipItemRenderer', () => {
  it('marks a new-member item and keeps the welcome text', () => {
    const item = parseOne(membershipNew);
    expect(item.membership).toEqual({ milestone: false, headerText: 'Welcome to Fan Club!' });
    expect(item.author.name).toBe('NewFan');
    expect(item.isMembership).toBe(true);
  });

  it('marks a milestone with headerPrimaryText and keeps the member comment', () => {
    const item = parseOne(membershipMilestone);
    expect(item.membership).toEqual({ milestone: true, headerText: 'Member for 6 months' });
    // message runs = the member's own comment, not the tier name
    const text = item.message.map((p) => p.text ?? p.emojiText ?? '').join('');
    expect(text).toBe('love the streams :heart:');
  });

  it('suppresses the tier-name pseudo-message on a milestone without comment', () => {
    const item = parseOne(membershipMilestoneNoMsg);
    expect(item.membership).toEqual({ milestone: true, headerText: 'Member for 12 months' });
    expect(item.message).toEqual([]); // headerSubtext "Member" must not leak as chat text
  });
});

describe('patched parser: gift renderers (dropped by stock parser)', () => {
  it('parses giftPurchaseAnnouncement with gifter identity and count', () => {
    const item = parseOne(giftPurchase);
    expect(item.author.name).toBe('GenerousGifter');
    expect(item.author.channelId).toBe('UCgifter00000000000000000');
    expect(item.membershipGift).toEqual({ count: 5, headerText: 'Gifted 5 Fan Club memberships' });
    expect(item.id).toBe('ChwKGkNQZm4wYUxUcC1BREZjOEs1UW9kQWc0QW5E');
  });

  it('parses giftRedemptionAnnouncement as a marked recipient message', () => {
    const item = parseOne(giftRedemption);
    expect(item.author.name).toBe('LuckyViewer');
    expect(item.membershipGiftReceived).toBe(true);
    const text = item.message.map((p) => p.text ?? '').join('');
    expect(text).toBe('was gifted a membership by GenerousGifter');
  });
});

describe('patched parser: giftMessageViewModel (paid Jewels/animated-gift)', () => {
  it('parses the ViewModel shape: gifter, gift name, id — captured from a live stream', () => {
    const item = parseOne(giftMessage);
    // ViewModel author field is "@name " with a leading @ and trailing space
    // (unlike classic renderers' authorName.simpleText) — strip both.
    expect(item.author.name).toBe('Jaydengames017');
    expect(item.id).toBe('ChwKGkNMMjF4ZkRtM0pVREZVZXd3Z0VkOEZRYUhn');
    const text = item.message.map((p) => p.text ?? '').join('');
    expect(text).toBe('sent Gold coin');
    // Gift name classified off structure (text.content minus the "sent "
    // verb), not off the literal tier string — a different tier would parse
    // the same way without a new fixture.
    expect(item.giftMessage).toEqual({ giftName: 'Gold coin' });
  });

  it('does not carry a real send timestamp (ViewModel has no timestampUsec)', () => {
    const before = Date.now();
    const item = parseOne(giftMessage);
    expect(item.timestamp.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('patched parser: unrecognized renderer types', () => {
  it('surfaces an unrecognized top-level renderer instead of silently dropping it', () => {
    const item = parseOne(unknownRenderer);
    expect(item.rendererType).toBe('unknown');
    expect(item.unknownType).toBe('liveChatPaidJewelRenderer');
    expect(item.raw).toEqual(unknownRenderer.liveChatPaidJewelRenderer);
  });

  it('leaves an unrelated viewModel sibling (viewer-engagement welcome message) on the unknown/capture path', () => {
    // Negative fixture, captured alongside the gift line: proves the new
    // giftMessageViewModel branch is scoped to that exact key and doesn't
    // accidentally widen to catch other viewModel-shaped renderers.
    const item = parseOne(viewerEngagement);
    expect(item.rendererType).toBe('unknown');
    expect(item.unknownType).toBe('liveChatViewerEngagementMessageRenderer');
    expect(item.raw).toEqual(viewerEngagement.liveChatViewerEngagementMessageRenderer);
  });

  it('a known-benign non-addChatItemAction action (ticker) is still dropped silently', () => {
    const data = actionData({ addLiveChatTickerItemAction: { some: 'ticker payload' } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([]);
  });

  it('an unrecognized action key is surfaced as unknownAction instead of silently dropped', () => {
    const action = { addBannerToLiveChatCommand: { some: 'banner payload' } };
    const data = actionData(action);
    const [chatItems] = parseChatData(data);
    expect(chatItems).toHaveLength(1);
    expect(chatItems[0]).toEqual({
      rendererType: 'unknownAction',
      unknownType: 'addBannerToLiveChatCommand',
      raw: action,
    });
  });

  // Regression for a live-capture bug: clickTrackingParams rides alongside
  // the real action key and sorted first here, so Object.keys(data)[0] keyed
  // the capture line as "clickTrackingParams" and threw away the actual
  // action (a tracking token, not the payload the capture path exists to
  // harvest). Key selection must skip known-noise keys and the full action
  // object must always be captured, so a wrong or noise-only guess never
  // loses data.
  it('skips clickTrackingParams noise when picking the unknownAction key, and captures the full action', () => {
    const action = {
      clickTrackingParams: 'CAAQl98BIhMIhbW0-tv-jgMVAAAAAB0AAAAA',
      addBannerToLiveChatCommand: { some: 'banner payload' },
    };
    const data = actionData(action);
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{
      rendererType: 'unknownAction',
      unknownType: 'addBannerToLiveChatCommand',
      raw: action,
    }]);
  });

  it('keys as "unknown" instead of dropping when every action key is noise', () => {
    const action = { clickTrackingParams: 'CAAQl98BIhMIhbW0-tv-jgMVAAAAAB0AAAAA' };
    const data = actionData(action);
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{
      rendererType: 'unknownAction',
      unknownType: 'unknown',
      raw: action,
    }]);
  });

  // Regression: actions the parser already classifies (addChatItemAction,
  // the mod actions, the ticker noise action) must never fall through to the
  // generic unknownAction capture path, clickTrackingParams sibling or not —
  // the noise-key skip must not widen what counts as "unrecognized".
  it('a known-classified action with a clickTrackingParams sibling never reaches unknownAction capture', () => {
    const data = actionDataWithTracking({
      markChatItemAsDeletedAction: { targetItemId: 'Chz-target-id' },
    });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{ rendererType: 'deletion', targetId: 'Chz-target-id' }]);
  });

  it('addChatItemAction with a clickTrackingParams sibling still parses as a normal chat item', () => {
    const [chatItems] = parseChatData(chatDataWithTracking(membershipNew));
    expect(chatItems).toHaveLength(1);
    expect(chatItems[0].rendererType).not.toBe('unknownAction');
  });
});

describe('patched parser: mod actions (deletion/author-removal)', () => {
  it('markChatItemAsDeletedAction surfaces as a deletion control item, no longer dropped', () => {
    const data = actionData({ markChatItemAsDeletedAction: { targetItemId: 'Chz-target-id' } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{ rendererType: 'deletion', targetId: 'Chz-target-id' }]);
  });

  it('removeChatItemAction surfaces as a deletion control item with the same shape', () => {
    const data = actionData({ removeChatItemAction: { targetItemId: 'Chz-other-target' } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{ rendererType: 'deletion', targetId: 'Chz-other-target' }]);
  });

  it('markChatItemsByAuthorAsDeletedAction surfaces as an authorDeletion control item', () => {
    const data = actionData({ markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'UCbadactor00000000000000' } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{ rendererType: 'authorDeletion', authorChannelId: 'UCbadactor00000000000000' }]);
  });

  // Fixture pulled verbatim from a live capture in unknown-renderers.jsonl —
  // this action key was previously falling through to unknownAction capture
  // (same failure mode/fix as markChatItemAsDeletedAction vs
  // removeChatItemAction above) instead of getting the same authorDeletion
  // treatment as markChatItemsByAuthorAsDeletedAction, despite identical
  // {externalChannelId} shape.
  it('removeChatItemByAuthorAction surfaces as an authorDeletion control item with the same shape', () => {
    const data = actionData({ removeChatItemByAuthorAction: { externalChannelId: 'UCE8M1SgN-4tFO4TbpYqRJMA' } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{ rendererType: 'authorDeletion', authorChannelId: 'UCE8M1SgN-4tFO4TbpYqRJMA' }]);
  });

  it('a deletion action missing targetItemId degrades to unknownAction capture instead of a broken control item', () => {
    const data = actionData({ markChatItemAsDeletedAction: { somethingElse: true } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{
      rendererType: 'unknownAction',
      unknownType: 'markChatItemAsDeletedAction',
      raw: { somethingElse: true },
    }]);
  });

  it('an author-deletion action missing externalChannelId degrades to unknownAction capture', () => {
    const data = actionData({ markChatItemsByAuthorAsDeletedAction: { somethingElse: true } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{
      rendererType: 'unknownAction',
      unknownType: 'markChatItemsByAuthorAsDeletedAction',
      raw: { somethingElse: true },
    }]);
  });

  it('a removeChatItemByAuthorAction missing externalChannelId degrades to unknownAction capture, keyed under its own name', () => {
    const data = actionData({ removeChatItemByAuthorAction: { somethingElse: true } });
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{
      rendererType: 'unknownAction',
      unknownType: 'removeChatItemByAuthorAction',
      raw: { somethingElse: true },
    }]);
  });
});

// ROOMSTATE parity (PR #38's 2026-08-08 streak coverage audit, item 3): YouTube's
// analog of Twitch's slow/sub-only/emote-only ROOMSTATE deltas. Control item,
// same shape family as the deletion/authorDeletion items above — never a
// real ChatItem (no author/id/timestamp), short-circuited before the classic
// extraction in parseActionToChatItem.
describe('patched parser: liveChatModeChangeMessageRenderer (ROOMSTATE parity)', () => {
  it('surfaces a modeChange control item with the rendered text (slow mode, with subtext present but unused)', () => {
    const data = chatDataWith(modeChangeSlowmode);
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{ rendererType: 'modeChange', text: 'Slow mode is on' }]);
  });

  it('surfaces a modeChange control item when there is no subtext at all (sub-only mode)', () => {
    const data = chatDataWith(modeChangeSubonly);
    const [chatItems] = parseChatData(data);
    expect(chatItems).toEqual([{ rendererType: 'modeChange', text: '@Cool_Broadcaster turned on subscribers-only mode' }]);
  });
});

describe('normalizeChatItem: ytId passthrough', () => {
  it('forwards the YT native message id as ytId, regular message', () => {
    const msg = normalizeChatItem({
      id: 'Chz-plain-text-message-id',
      author: { name: 'Someone' },
      message: [{ text: 'hello' }],
    });
    expect(msg.ytId).toBe('Chz-plain-text-message-id');
  });
});

describe('normalizeChatItem membership kinds', () => {
  it('member_new: gold row, welcome text, no amount', () => {
    const msg = normalizeChatItem(parseOne(membershipNew));
    expect(msg).toEqual({
      user: 'NewFan',
      text: 'Welcome to Fan Club!',
      kind: 'member_new',
      isMember: true,
      ytId: 'ChwKGkNKdUEwYUxUcC1BREZjOEs1UW9kQWc0QW5B',
      authorId: 'UCnewmember00000000000000',
    });
  });

  it('member_milestone: header — comment, no amount', () => {
    const msg = normalizeChatItem(parseOne(membershipMilestone));
    expect(msg).toEqual({
      user: 'LoyalViewer',
      text: 'Member for 6 months — love the streams :heart:',
      kind: 'member_milestone',
      isMember: true,
      ytId: 'ChwKGkNPdkQwYUxUcC1BREZjOEs1UW9kQWc0QW5C',
      authorId: 'UCmilestone00000000000000',
    });
  });

  it('member_milestone without comment: header only', () => {
    const msg = normalizeChatItem(parseOne(membershipMilestoneNoMsg));
    expect(msg.text).toBe('Member for 12 months');
    expect(msg.kind).toBe('member_milestone');
    expect(msg.amount).toBeUndefined();
  });

  it('member_gift: gift count rides the amount badge', () => {
    const msg = normalizeChatItem(parseOne(giftPurchase));
    expect(msg).toEqual({
      user: 'GenerousGifter',
      text: 'Gifted 5 Fan Club memberships',
      kind: 'member_gift',
      amount: '5 gifts',
      isMember: true,
      ytId: 'ChwKGkNQZm4wYUxUcC1BREZjOEs1UW9kQWc0QW5E',
      authorId: 'UCgifter00000000000000000',
    });
  });

  it('member_gift: singular count', () => {
    const msg = normalizeChatItem({
      author: { name: 'OneGift' },
      membershipGift: { count: 1, headerText: 'Gifted 1 Fan Club membership' },
    });
    expect(msg.amount).toBe('1 gift');
  });

  it('member_gift_received: recipient row, no amount', () => {
    const msg = normalizeChatItem(parseOne(giftRedemption));
    expect(msg).toEqual({
      user: 'LuckyViewer',
      text: 'was gifted a membership by GenerousGifter',
      kind: 'member_gift_received',
      ytId: 'ChwKGkNKX2YwYUxUcC1BREZjOEs1UW9kQWc0QW5F',
      authorId: 'UCrecipient00000000000000',
    });
  });

  it('regular message from an existing member does NOT become a membership kind', () => {
    const msg = normalizeChatItem({
      author: { name: 'OldMember' },
      message: [{ text: 'hello' }],
      isMembership: true, // badge flag only — the known false positive
    });
    expect(msg).toEqual({ user: 'OldMember', text: 'hello', isMember: true });
  });

  it('falls back to KIND_FALLBACK_TEXT when an event has no derivable text', () => {
    const msg = normalizeChatItem({
      author: { name: 'Mystery' },
      membership: { milestone: false, headerText: '' },
      message: [],
    });
    expect(msg.text).toBe(KIND_FALLBACK_TEXT.member_new);
  });
});

describe('normalizeChatItem: yt_gift (paid Jewels/animated-gift, distinct from member_gift)', () => {
  it('yt_gift: gifter as user, gift name rides the amount badge', () => {
    const msg = normalizeChatItem(parseOne(giftMessage));
    expect(msg).toEqual({
      user: 'Jaydengames017',
      text: 'sent Gold coin',
      kind: 'yt_gift',
      amount: 'Gold coin',
      ytId: 'ChwKGkNMMjF4ZkRtM0pVREZVZXd3Z0VkOEZRYUhn',
    });
  });

  it('a different gift tier normalizes the same way with no new fixture (structural classification)', () => {
    const msg = normalizeChatItem({
      id: 'Chz-other-tier-id',
      author: { name: 'AnotherGifter' },
      message: [{ text: 'sent 5 Roses' }],
      giftMessage: { giftName: '5 Roses' },
    });
    expect(msg.kind).toBe('yt_gift');
    expect(msg.amount).toBe('5 Roses');
  });

  it('falls back to KIND_FALLBACK_TEXT.yt_gift when text is empty', () => {
    const msg = normalizeChatItem({
      author: { name: 'Mystery' },
      message: [],
      giftMessage: { giftName: 'Unknown Gift' },
    });
    expect(msg.text).toBe(KIND_FALLBACK_TEXT.yt_gift);
    expect(msg.kind).toBe('yt_gift');
  });
});
