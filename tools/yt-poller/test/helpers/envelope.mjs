import { expect } from 'vitest';
import { parseChatData } from 'youtube-chat/dist/parser.js';

// Wraps arbitrary continuation actions in a minimal get_live_chat response —
// the one shape every fixture-driven poller test needs, whether the action
// is a chat item, a mod action, or an unrecognized/ticker action.
export function actionData(...actions) {
  return {
    continuationContents: {
      liveChatContinuation: {
        actions,
        continuations: [{ invalidationContinuationData: { continuation: 'next-token' } }],
      },
    },
  };
}

// Wrap renderer-level fixture(s) in the addChatItemAction shape.
export function chatDataWith(...items) {
  return actionData(...items.map((item) => ({ addChatItemAction: { item, clientId: 'x' } })));
}

// clickTrackingParams rides alongside the real action key on live captures —
// these two exist to prove that sibling key never widens what counts as
// "unrecognized" (see membership.test.mjs's clickTrackingParams regression
// tests).
export function actionDataWithTracking(action) {
  return actionData({ clickTrackingParams: 'CAAQl98BIhMIhbW0-tv-jgMVAAAAAB0AAAAA', ...action });
}

export function chatDataWithTracking(item) {
  return actionDataWithTracking({ addChatItemAction: { item, clientId: 'x' } });
}

// Wraps mutations in a minimal get_live_chat response carrying
// frameworkUpdates alongside an empty actions array — the shape reaction
// bursts ride (see the frameworkUpdates hook in
// patches/youtube-chat+2.2.0.patch), distinct from every other fixture
// helper above which only ever populates actions.
export function frameworkUpdatesData(mutations) {
  return { ...actionData(), frameworkUpdates: { entityBatchUpdate: { mutations } } };
}

export function parseOne(fixture) {
  const [chatItems] = parseChatData(chatDataWith(fixture));
  expect(chatItems).toHaveLength(1);
  return chatItems[0];
}
