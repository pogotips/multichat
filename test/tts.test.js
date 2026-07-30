import { describe, it, expect } from 'vitest';
import { emitCategory, isEmittable, formatUtterance, enqueueCapped } from '../src/worker.js';
// Plain-value constants live in lib.js, not the entry module — see lib.js's
// header comment (workerd rejects a non-function/class entry-module export).
import { VALID_KINDS, TTS_LABELS, EMIT_TTL_MS } from '../src/lib.js';

describe('emitCategory', () => {
  it('financial for a paid kind', () => {
    expect(emitCategory({ kind: 'cheer' })).toBe('financial');
    expect(emitCategory({ kind: 'yt_gift' })).toBe('financial');
  });

  it('silent for member_gift_received (redemption rows, not the bomb itself)', () => {
    expect(emitCategory({ kind: 'member_gift_received' })).toBe('silent');
  });

  it('raid for a raid system row (buzz only, never spoken)', () => {
    expect(emitCategory({ sys: 'raid' })).toBe('raid');
  });

  it('silent for a plain chat row and other system rows', () => {
    expect(emitCategory({})).toBe('silent');
    expect(emitCategory({ sys: 'roomstate' })).toBe('silent');
  });
});

describe('isEmittable', () => {
  const now = 1_000_000_000_000;
  const base = { floor: 0, spokenIds: new Map(), now };

  it('true for a live financial row above the floor, unseen, within TTL', () => {
    expect(isEmittable({ id: 10, kind: 'cheer', ts: now }, base)).toBe(true);
  });

  it('true for a raid row (category raid, gate otherwise passes)', () => {
    expect(isEmittable({ id: 10, sys: 'raid', ts: now }, base)).toBe(true);
  });

  it('false for a silent category regardless of gate', () => {
    expect(isEmittable({ id: 10, ts: now }, base)).toBe(false);
    expect(isEmittable({ id: 10, kind: 'member_gift_received', ts: now }, base)).toBe(false);
  });

  it('false at or below the floor (history boundary)', () => {
    expect(isEmittable({ id: 5, kind: 'cheer', ts: now }, { ...base, floor: 5 })).toBe(false);
    expect(isEmittable({ id: 6, kind: 'cheer', ts: now }, { ...base, floor: 5 })).toBe(true);
  });

  it('false when already fired (spokenIds dedup — live or replayed)', () => {
    const spokenIds = new Map([[10, now]]);
    expect(isEmittable({ id: 10, kind: 'cheer', ts: now }, { ...base, spokenIds })).toBe(false);
  });

  it('false when older than EMIT_TTL_MS (stale replay must not fire)', () => {
    expect(isEmittable({ id: 10, kind: 'cheer', ts: now - EMIT_TTL_MS - 1 }, base)).toBe(false);
    expect(isEmittable({ id: 10, kind: 'cheer', ts: now - EMIT_TTL_MS + 1 }, base)).toBe(true);
  });

  it('stale-floor flood guard (amendment 1): a full replay against an old floor fires only rows under the age cap', () => {
    // Reproduces "open the page a day later": floor is stale (low), so every
    // replayed queued row is above it and unseen. Without the age term this
    // floods; with it, only rows younger than EMIT_TTL_MS fire.
    const staleFloor = 0;
    const spokenIds = new Map();
    const gate = { floor: staleFloor, spokenIds, now };
    const replay = [
      { id: 101, kind: 'superchat', ts: now - EMIT_TTL_MS - 60_000 }, // ~31+ min old — history
      { id: 102, kind: 'cheer', ts: now - 2 * EMIT_TTL_MS },          // ~1h old — history
      { id: 103, kind: 'yt_gift', ts: now - 60_000 },                 // 1 min old — genuinely new
      { id: 104, sys: 'roomstate', ts: now },                          // silent regardless
    ];
    const fired = replay.filter((m) => isEmittable(m, gate));
    expect(fired.map((m) => m.id)).toEqual([103]); // zero utterances beyond rows under 30 min old
  });

  it('does not reference navigator or speechSynthesis capability', () => {
    // Eligibility must hold even where these globals are absent (iOS Safari
    // has no navigator.vibrate) — capability is checked by each call site,
    // never inside the shared predicate.
    expect(isEmittable.toString()).not.toMatch(/navigator|speechSynthesis/);
  });
});

describe('TTS_LABELS coverage', () => {
  it('has an explicit label for every kind the predicate can pass', () => {
    for (const kind of VALID_KINDS) {
      if (kind === 'member_gift_received') continue;
      expect(TTS_LABELS[kind], `missing TTS label for kind "${kind}"`).toBeDefined();
    }
  });

  it('disambiguates the two gift kinds', () => {
    expect(TTS_LABELS.member_gift).toBe('gifted memberships');
    expect(TTS_LABELS.yt_gift).toBe('gift');
    expect(TTS_LABELS.member_gift).not.toBe(TTS_LABELS.yt_gift);
  });
});

describe('formatUtterance', () => {
  it('formats a kind with no amount', () => {
    expect(formatUtterance({ user: 'Jayden', kind: 'sub' })).toBe('Jayden, sub');
  });

  it('formats a kind with an amount', () => {
    expect(formatUtterance({ user: 'GoldenTrainer', kind: 'superchat', amount: '$5.00' }))
      .toBe('GoldenTrainer, superchat, $5.00');
  });

  it('speaks amount verbatim, no reformatting', () => {
    expect(formatUtterance({ user: 'Jayden', kind: 'member_gift', amount: 'Gold coin' }))
      .toBe('Jayden, gifted memberships, Gold coin');
  });

  it('falls back to the raw kind string when unmapped', () => {
    expect(formatUtterance({ user: 'X', kind: 'mystery_kind' })).toBe('X, mystery_kind');
  });

  it('never reads msg.text', () => {
    const msg = { user: 'X', kind: 'cheer', text: 'raw chat body must not be spoken' };
    expect(formatUtterance(msg)).not.toContain('raw chat body');
    expect(formatUtterance.toString()).not.toMatch(/msg\.text/);
  });
});

describe('enqueueCapped', () => {
  it('appends under cap', () => {
    expect(enqueueCapped(['a'], 'b', 3)).toEqual(['a', 'b']);
  });

  it('drops oldest beyond cap, keeps arrival order', () => {
    expect(enqueueCapped(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });

  it('cap of zero yields empty', () => {
    expect(enqueueCapped([], 'a', 0)).toEqual([]);
  });
});
