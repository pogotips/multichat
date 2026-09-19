// Live reaction bursts (heart/like fountain) — ingest validation, DO state,
// and the status payload's reactions field. See CLAUDE.md / tools/yt-poller
// for the poller side (frameworkUpdates.entityBatchUpdate.mutations[].payload
// .emojiFountainDataEntity, verified 2026-09-14).
import { describe, it, expect, vi } from 'vitest';
import { sanitizeYtReactions } from '../src/worker.js';
import { makeHub, req } from './helpers/makeHub.js';

describe('sanitizeYtReactions', () => {
  it('accepts a well-formed single-emoji payload', () => {
    expect(sanitizeYtReactions({ emoji: { '❤': 9 }, intensity: 0.42 })).toEqual({
      emoji: { '❤': 9 },
      intensity: 0.42,
    });
  });

  it('accepts multiple emoji, sorted by count descending', () => {
    const result = sanitizeYtReactions({ emoji: { '😂': 3, '❤': 9 }, intensity: 0.1 });
    expect(Object.keys(result.emoji)).toEqual(['❤', '😂']);
  });

  it('rejects the whole payload when body.emoji is missing/not an object', () => {
    expect(sanitizeYtReactions({ intensity: 0.5 })).toBeNull();
    expect(sanitizeYtReactions({ emoji: 'nope', intensity: 0.5 })).toBeNull();
    expect(sanitizeYtReactions({ emoji: null })).toBeNull();
    expect(sanitizeYtReactions(null)).toBeNull();
  });

  it('drops a key that is not an emoji (plain text/digits), keeping valid siblings', () => {
    const result = sanitizeYtReactions({ emoji: { hack: 999, '❤': 5 }, intensity: 0 });
    expect(result.emoji).toEqual({ '❤': 5 });
  });

  it('returns null when every key is invalid — never a partial junk-only payload', () => {
    expect(sanitizeYtReactions({ emoji: { hack: 999, '<script>': 1 } })).toBeNull();
  });

  it('drops a non-integer, negative, zero, or oversize count', () => {
    const result = sanitizeYtReactions({
      emoji: { '❤': 5.5, '😂': -1, '👍': 0, '🎉': 1_000_001, '🔥': 5 },
    });
    expect(result.emoji).toEqual({ '🔥': 5 });
  });

  it('caps at the top 20 emoji by count, dropping the rest', () => {
    const emoji = {};
    for (let i = 0; i < 25; i++) emoji[String.fromCodePoint(0x1f600 + i)] = 25 - i;
    const result = sanitizeYtReactions({ emoji });
    expect(Object.keys(result.emoji)).toHaveLength(20);
    // Highest counts survive, not an arbitrary/insertion-order slice.
    expect(result.emoji[String.fromCodePoint(0x1f600)]).toBe(25);
  });

  it('rejects an overlong key (defends against a junk/attack string masquerading as an emoji)', () => {
    const longKey = '❤'.repeat(30);
    const result = sanitizeYtReactions({ emoji: { [longKey]: 5, '❤': 3 } });
    expect(result.emoji).toEqual({ '❤': 3 });
  });

  it('rejects a key that only CONTAINS a pictograph rather than consisting entirely of one — regex must be anchored', () => {
    const result = sanitizeYtReactions({ emoji: { 'junktext❤': 5, '❤': 3 } });
    expect(result.emoji).toEqual({ '❤': 3 });
  });

  it('accepts real multi-codepoint emoji sequences (flag, skin-tone modifier, ZWJ family, VS16 form)', () => {
    const result = sanitizeYtReactions({
      emoji: { '🇺🇸': 1, '👍🏽': 2, '👨‍👩‍👧‍👦': 3, '❤️': 4 },
    });
    expect(Object.keys(result.emoji)).toHaveLength(4);
  });

  it('rejects a key made only of joiners/modifiers with no pictographic base (ZWJ, VS16, skin tone, keycap combiner)', () => {
    expect(sanitizeYtReactions({ emoji: { '‍': 5 } })).toBeNull();
    expect(sanitizeYtReactions({ emoji: { '️': 5 } })).toBeNull();
    expect(sanitizeYtReactions({ emoji: { '\u{1F3FD}': 5 } })).toBeNull(); // skin-tone modifier alone
    expect(sanitizeYtReactions({ emoji: { '⃣': 5 } })).toBeNull();
    expect(sanitizeYtReactions({ emoji: { '‍️⃣': 5 } })).toBeNull();
    expect(sanitizeYtReactions({ emoji: { '\u{1F3FD}‍': 5 } })).toBeNull();
  });

  it('keeps a valid sibling when a joiner-only key is dropped', () => {
    const result = sanitizeYtReactions({ emoji: { '‍️': 99, '❤': 3 } });
    expect(result.emoji).toEqual({ '❤': 3 });
  });

  it('clamps intensity into [0, 1] and defaults to 0 when absent/non-finite', () => {
    expect(sanitizeYtReactions({ emoji: { '❤': 1 }, intensity: 5 }).intensity).toBe(1);
    expect(sanitizeYtReactions({ emoji: { '❤': 1 }, intensity: -3 }).intensity).toBe(0);
    expect(sanitizeYtReactions({ emoji: { '❤': 1 } }).intensity).toBe(0);
    expect(sanitizeYtReactions({ emoji: { '❤': 1 }, intensity: 'hot' }).intensity).toBe(0);
  });
});

describe('handleIngestYt: type "yt_reactions"', () => {
  it('a valid POST updates DO state and broadcasts status immediately (nonzero-only push)', async () => {
    const { hub } = makeHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const res = await hub.handleIngestYt(req({ type: 'yt_reactions', emoji: { '❤': 9 }, intensity: 0.5 }));
    expect(res.status).toBe(200);
    expect(hub.ytReactions).toEqual({ emoji: { '❤': 9 }, intensity: 0.5 });
    expect(hub.ytReactionsAt).toBeGreaterThan(0);
    expect(broadcastSpy).toHaveBeenCalledWith('status', expect.any(Object));
  });

  it('a malformed POST (no valid emoji keys) is rejected 400 and never touches DO state', async () => {
    const { hub } = makeHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const res = await hub.handleIngestYt(req({ type: 'yt_reactions', emoji: { junk: 1 } }));
    expect(res.status).toBe(400);
    expect(hub.ytReactions).toBeNull();
    expect(hub.ytReactionsAt).toBe(0);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('never touches the ring — not a chat row', async () => {
    const { hub } = makeHub();
    await hub.handleIngestYt(req({ type: 'yt_reactions', emoji: { '❤': 9 }, intensity: 0.5 }));
    expect(hub.ring).toHaveLength(0);
  });

  it('rejects a non-poller caller (e.g. the raidq cron secret) with 403, same scoping as the mod branch', async () => {
    const { hub } = makeHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcastEvent');
    const res = await hub.handleIngestYt(
      req({ type: 'yt_reactions', emoji: { '❤': 9 }, intensity: 0.5 }, { caller: 'raidq' }),
    );
    expect(res.status).toBe(403);
    expect(hub.ytReactions).toBeNull();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});

describe('buildStatusPayload reactions field', () => {
  it('is null when no reaction burst has ever landed', () => {
    const { hub } = makeHub();
    expect(hub.buildStatusPayload().reactions).toBeNull();
  });

  it('reflects a fresh burst with emoji/intensity/ts', () => {
    const { hub } = makeHub();
    hub.ytReactions = { emoji: { '❤': 9 }, intensity: 0.5 };
    hub.ytReactionsAt = Date.now();
    const status = hub.buildStatusPayload();
    expect(status.reactions).toEqual({ emoji: { '❤': 9 }, intensity: 0.5, ts: hub.ytReactionsAt });
  });

  it('decays to null once past YT_REACTIONS_STALE_MS — never lingers dimmed like the count fields', () => {
    const { hub } = makeHub();
    hub.ytReactions = { emoji: { '❤': 9 }, intensity: 0.5 };
    hub.ytReactionsAt = Date.now() - 16_000; // > 15s stale threshold
    expect(hub.buildStatusPayload().reactions).toBeNull();
  });
});
