// Live reaction bursts (heart/like fountain) — frameworkUpdates.entityBatchUpdate
// .mutations[].payload.emojiFountainDataEntity, verified externally 2026-09-14
// (see multichat/CLAUDE.md's yt-poller sections). Covers: the patch hook that
// surfaces the entity through parseChatData, the pure aggregation functions in
// capture.mjs, and a static guard on the checked-in patch file itself.
//
// Runs under the multichat root's vitest (`npm test`); imports resolve
// against tools/yt-poller/node_modules, so `npm install` there first.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChatData } from 'youtube-chat/dist/parser.js';
import { frameworkUpdatesData } from './helpers/envelope.mjs';
import {
  reactionCaptureLine, aggregateReactionBuckets, shouldPostReaction, reactionPostPayload,
} from '../capture.mjs';
import reactionNonzero from './fixtures/reaction-nonzero.json';
import reactionZero from './fixtures/reaction-zero.json';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PATCH_SOURCE = fs.readFileSync(
  path.join(DIR, '..', 'patches', 'youtube-chat+2.2.0.patch'),
  'utf8',
);

function mutationsWith(entity) {
  return [{ payload: { emojiFountainDataEntity: entity } }];
}

describe('patch substance: youtube-chat+2.2.0.patch (static check, no node_modules needed)', () => {
  // Static text guard on the checked-in patch file itself, distinct from
  // scripts/check-poller-deps.mjs's SENTINEL (which only proves SOME hunk of
  // the patch landed post-install, via a different renderer's marker) — this
  // one guards specifically against the frameworkUpdates hunk being dropped
  // in a future patch regeneration while an unrelated sentinel string
  // survives untouched.
  it('patches parser.js, not some other file', () => {
    expect(PATCH_SOURCE).toMatch(/--- a\/node_modules\/youtube-chat\/dist\/parser\.js/);
  });

  it('reads frameworkUpdates.entityBatchUpdate.mutations', () => {
    expect(PATCH_SOURCE).toContain('data.frameworkUpdates');
    expect(PATCH_SOURCE).toContain('entityBatchUpdate');
    expect(PATCH_SOURCE).toContain('mutations');
  });

  it('filters for emojiFountainDataEntity and tags the result rendererType "emojiFountain"', () => {
    expect(PATCH_SOURCE).toContain('emojiFountainDataEntity');
    expect(PATCH_SOURCE).toContain('"emojiFountain"');
  });

  it('concats onto chatItems rather than replacing it (chat items must still flow)', () => {
    expect(PATCH_SOURCE).toMatch(/chatItems\s*=\s*chatItems\.concat\(/);
  });
});

describe('parseChatData: frameworkUpdates -> emojiFountain chat items', () => {
  it('surfaces a nonzero entity as a rendererType:"emojiFountain" chat item', () => {
    const [chatItems] = parseChatData(frameworkUpdatesData(mutationsWith(reactionNonzero)));
    expect(chatItems).toHaveLength(1);
    expect(chatItems[0].rendererType).toBe('emojiFountain');
    expect(chatItems[0].raw).toEqual(reactionNonzero);
  });

  it('still surfaces an all-zero entity as a chat item — skip logic lives in capture.mjs, not the parser', () => {
    const [chatItems] = parseChatData(frameworkUpdatesData(mutationsWith(reactionZero)));
    expect(chatItems).toHaveLength(1);
    expect(chatItems[0].rendererType).toBe('emojiFountain');
  });

  it('yields zero chat items when frameworkUpdates is absent entirely (the common case — most polls)', () => {
    const data = frameworkUpdatesData([]);
    delete data.frameworkUpdates;
    const [chatItems] = parseChatData(data);
    expect(chatItems).toHaveLength(0);
  });

  it('ignores mutations whose payload has no emojiFountainDataEntity (other entity types on the same poll)', () => {
    const [chatItems] = parseChatData(
      frameworkUpdatesData([{ payload: { someOtherEntity: { x: 1 } } }]),
    );
    expect(chatItems).toHaveLength(0);
  });

  it('never disturbs a real chat action sharing the same poll (concat, not replace)', () => {
    const data = frameworkUpdatesData(mutationsWith(reactionNonzero));
    data.continuationContents.liveChatContinuation.actions = [
      { addChatItemAction: { item: { liveChatTextMessageRenderer: {
        id: 'x', timestampUsec: '1', authorName: { simpleText: 'A' },
        authorPhoto: { thumbnails: [{ url: 'https://example.com/a.png' }] },
        message: { runs: [{ text: 'hi' }] },
      } } } },
    ];
    const [chatItems] = parseChatData(data);
    expect(chatItems).toHaveLength(2);
    expect(chatItems.map((i) => i.rendererType)).toContain('emojiFountain');
  });
});

describe('reactionCaptureLine (per-bucket detail for the log-only capture file)', () => {
  it('nonzero entity: maps buckets to {total, intensity, emoji}', () => {
    const line = reactionCaptureLine(reactionNonzero, { ts: 123, videoId: 'v1' });
    expect(line).toEqual({
      ts: 123,
      videoId: 'v1',
      updateTimeUsec: '1757800000000000',
      buckets: [{ total: 12, intensity: 0.42, emoji: { '❤': 9, '😂': 3 } }],
    });
  });

  it('all-zero entity: returns null (skip — never write a no-op line)', () => {
    expect(reactionCaptureLine(reactionZero, { ts: 1, videoId: 'v1' })).toBeNull();
  });

  it('absent reactionsData on a zero bucket defaults emoji to {} rather than throwing', () => {
    const line = reactionCaptureLine(
      { reactionBuckets: [{ totalReactions: 5, intensityScore: 0.1 }], updateTimeUsec: 'x' },
      { ts: 1, videoId: 'v1' },
    );
    expect(line.buckets[0].emoji).toEqual({});
  });

  it('no reactionBuckets at all: treated as all-zero, returns null', () => {
    expect(reactionCaptureLine({ updateTimeUsec: 'x' }, { ts: 1, videoId: 'v1' })).toBeNull();
  });
});

describe('aggregateReactionBuckets (single-summary shape for the ingest lane)', () => {
  it('nonzero entity: sums totals, takes max intensity, merges emoji counts', () => {
    expect(aggregateReactionBuckets(reactionNonzero)).toEqual({
      total: 12,
      intensity: 0.42,
      emoji: { '❤': 9, '😂': 3 },
    });
  });

  it('all-zero entity: returns null (never posts a no-op ingest message)', () => {
    expect(aggregateReactionBuckets(reactionZero)).toBeNull();
  });

  it('multiple buckets: max intensity wins even from a smaller-total bucket', () => {
    const raw = {
      reactionBuckets: [
        { totalReactions: 40, intensityScore: 0.2, reactionsData: [{ unicodeEmojiId: '👍', reactionCount: 40 }] },
        { totalReactions: 2, intensityScore: 0.9, reactionsData: [{ unicodeEmojiId: '🎉', reactionCount: 2 }] },
      ],
    };
    const agg = aggregateReactionBuckets(raw);
    expect(agg.total).toBe(42);
    expect(agg.intensity).toBe(0.9);
    expect(agg.emoji).toEqual({ '👍': 40, '🎉': 2 });
  });

  it('no reactionBuckets at all: returns null', () => {
    expect(aggregateReactionBuckets({})).toBeNull();
  });
});

describe('shouldPostReaction (dedupe decision: usec advance OR same-usec total growth)', () => {
  it('no prior state: always posts', () => {
    expect(shouldPostReaction('100', 5, null)).toBe(true);
  });

  it('new usec: posts even if total is smaller than the prior window\'s', () => {
    expect(shouldPostReaction('200', 1, { usec: '100', total: 50, emoji: {} })).toBe(true);
  });

  it('same usec, equal total: does not post (unchanged re-send)', () => {
    expect(shouldPostReaction('100', 12, { usec: '100', total: 12, emoji: {} })).toBe(false);
  });

  it('same usec, smaller total: does not post', () => {
    expect(shouldPostReaction('100', 5, { usec: '100', total: 12, emoji: {} })).toBe(false);
  });

  it('same usec, larger total: posts (the window has not rolled but more reactions landed)', () => {
    expect(shouldPostReaction('100', 20, { usec: '100', total: 12, emoji: {} })).toBe(true);
  });
});

describe('reactionPostPayload (delta on same-usec growth, full agg on a new window)', () => {
  it('no prior state: posts the full agg unchanged', () => {
    const agg = { total: 12, intensity: 0.42, emoji: { '❤': 9, '😂': 3 } };
    expect(reactionPostPayload(agg, '100', null)).toEqual({ intensity: 0.42, emoji: { '❤': 9, '😂': 3 } });
  });

  it('new usec: posts the full agg unchanged, even with prior state present', () => {
    const agg = { total: 5, intensity: 0.1, emoji: { '👍': 5 } };
    const last = { usec: '100', total: 12, emoji: { '❤': 9, '😂': 3 } };
    expect(reactionPostPayload(agg, '200', last)).toEqual({ intensity: 0.1, emoji: { '👍': 5 } });
  });

  it('same usec, larger total: posts the per-emoji delta, not the full agg (client already added the prior poll to its rolling window)', () => {
    const last = { usec: '100', total: 3, emoji: { '❤': 3 } };
    const agg = { total: 6, intensity: 0.5, emoji: { '❤': 5, '😂': 1 } };
    expect(reactionPostPayload(agg, '100', last)).toEqual({ intensity: 0.5, emoji: { '❤': 2, '😂': 1 } });
  });

  it('same usec: a key present in last but absent from the new agg is simply absent from the delta, never negative', () => {
    const last = { usec: '100', total: 5, emoji: { '❤': 3, '🎉': 2 } };
    const agg = { total: 5, intensity: 0.2, emoji: { '❤': 5 } };
    expect(reactionPostPayload(agg, '100', last)).toEqual({ intensity: 0.2, emoji: { '❤': 2 } });
  });

  it('same usec, total grew but the emoji map did not: returns null (empty delta — nothing to post, the Worker would 400 it)', () => {
    const last = { usec: '100', total: 3, emoji: { '❤': 3 } };
    const agg = { total: 5, intensity: 0.5, emoji: { '❤': 3 } };
    expect(reactionPostPayload(agg, '100', last)).toBeNull();
  });

  it('nonzero buckets whose reactionsData YouTube omitted (empty agg.emoji): returns null on both the new-usec and same-usec paths', () => {
    const agg = { total: 5, intensity: 0.5, emoji: {} };
    expect(reactionPostPayload(agg, '200', null)).toBeNull();
    expect(reactionPostPayload(agg, '100', { usec: '100', total: 3, emoji: {} })).toBeNull();
  });
});

// poller.mjs isn't import-safe in a test process (top-level process.exit on
// missing env, run() side effect at module scope — see zombie-watchdog.
// test.mjs's no-export rationale), so this is a source-text regression
// guard, same pattern as heartbeat-interval.test.mjs.
const POLLER_SOURCE = fs.readFileSync(path.join(DIR, '..', 'poller.mjs'), 'utf8');
const RETRY_QUEUE_SOURCE = fs.readFileSync(path.join(DIR, '..', 'retry-queue.mjs'), 'utf8');

describe('poller.mjs reaction-burst wiring (source-text guard)', () => {
  it('the emojiFountain branch never falls through to classifyYtItem/normalizeChatItem (never a chat row)', () => {
    const branch = POLLER_SOURCE.slice(
      POLLER_SOURCE.indexOf("item.rendererType === 'emojiFountain'"),
      POLLER_SOURCE.indexOf("item.rendererType === 'deletion'"),
    );
    expect(branch).toContain('return;');
    expect(branch).not.toContain('classifyYtItem(');
    expect(branch).not.toContain('normalizeChatItem(');
  });

  it('posts type: yt_reactions, not a bare chat message', () => {
    expect(POLLER_SOURCE).toMatch(/post\(\{ type: 'yt_reactions'/);
  });

  it('reactionsSeen is cumulative and rides the poller_heartbeat log line', () => {
    expect(POLLER_SOURCE).toMatch(/let reactionsSeen = 0;/);
    expect(POLLER_SOURCE).toMatch(/reactionsSeen\+\+;/);
    expect(POLLER_SOURCE).toMatch(/ev:\s*'poller_heartbeat'/);
    const heartbeatLog = POLLER_SOURCE.slice(
      POLLER_SOURCE.indexOf("ev: 'poller_heartbeat'"),
      POLLER_SOURCE.indexOf("ev: 'poller_heartbeat'") + 600,
    );
    expect(heartbeatLog).toContain('reactionsSeen,');
  });

  it('yt_reactions bypasses the retry queue, same as heartbeat (a stale burst retry is pointless)', () => {
    expect(RETRY_QUEUE_SOURCE).toMatch(/msg\.type !== 'yt_reactions'/);
  });

  it('a null (empty-delta) payload skips the POST and the reactionsSeen bump but still advances lastReaction', () => {
    const branch = POLLER_SOURCE.slice(
      POLLER_SOURCE.indexOf("item.rendererType === 'emojiFountain'"),
      POLLER_SOURCE.indexOf("item.rendererType === 'deletion'"),
    );
    expect(branch).toContain('if (payload) {');
    // lastReaction advances before the guard, so the same empty-delta growth
    // isn't re-evaluated on every subsequent poll of the same window.
    expect(branch.indexOf('lastReaction =')).toBeLessThan(branch.indexOf('if (payload) {'));
    // Both the bump and the post live inside the guard — reactionsSeen keeps
    // meaning "posted bursts".
    expect(branch.indexOf('if (payload) {')).toBeLessThan(branch.indexOf('reactionsSeen++'));
    expect(branch.indexOf('reactionsSeen++')).toBeLessThan(branch.indexOf("post({ type: 'yt_reactions'"));
  });

  it('dedupes the ingest POST via shouldPostReaction (usec advance OR same-usec total growth), not raw usec-only comparison', () => {
    expect(POLLER_SOURCE).toMatch(/let lastReaction = null;/);
    expect(POLLER_SOURCE).toMatch(
      /shouldPostReaction\(item\.raw\.updateTimeUsec, agg\.total, lastReaction\)/,
    );
    expect(POLLER_SOURCE).toMatch(
      /reactionPostPayload\(agg, item\.raw\.updateTimeUsec, lastReaction\)/,
    );
  });
});
