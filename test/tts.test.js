import { describe, it, expect, vi } from 'vitest';
import { emitCategory, isEmittable, formatUtterance, enqueueCapped } from '../src/worker.js';
// Plain-value constants live in lib.js, not the entry module — see lib.js's
// header comment (workerd rejects a non-function/class entry-module export).
import { VALID_KINDS, TTS_LABELS, EMIT_TTL_MS, FINANCIAL_KINDS, cleanSpokenName } from '../src/lib.js';
import { makeHub } from './helpers/makeHub.js';

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

  it('silent for viewermilestone and YT modechange — gray rows, no TTS/buzz', () => {
    expect(emitCategory({ sys: 'viewermilestone' })).toBe('silent');
    expect(emitCategory({ sys: 'modechange' })).toBe('silent');
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

  // Privacy guard: chat bodies are never read aloud, only user + kind +
  // amount. Asserted behaviorally against a distinctive marker across a
  // mapped kind, an unmapped kind, and an amount-carrying kind — a source-text
  // check (`formatUtterance.toString()`) would pass under `const { text } = msg`
  // and fail on an unrelated comment, so it proves nothing.
  it('never speaks msg.text', () => {
    const MARKER = 'zzqq-raw-chat-body-marker';
    for (const kind of ['cheer', 'mystery_kind', 'member_gift']) {
      const spoken = formatUtterance({ user: 'X', kind, amount: 'Gold coin', text: MARKER });
      expect(spoken).not.toContain(MARKER);
      expect(spoken).not.toContain('zzqq');
    }
  });
});

// ── formatUtterance: resub streak — structured streakMonths field, never
// parsed from msg.text (see parseUsernotice). Cumulative months is
// display-only and never reaches formatUtterance at all.
describe('formatUtterance: resub streak', () => {
  it('speaks the streak at 2 months', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub', streakMonths: 2 }))
      .toBe('ronni, sub, 2 month streak');
  });

  it('speaks a longer streak (5 months)', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub', streakMonths: 5 }))
      .toBe('ronni, sub, 5 month streak');
  });

  it('omits below 2 months (streak=1 is a real but too-short streak)', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub', streakMonths: 1 })).toBe('ronni, sub');
  });

  it('omits when streakMonths=0 (tag present but hidden/should-share-streak=0)', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub', streakMonths: 0 })).toBe('ronni, sub');
  });

  it('omits when streakMonths is absent (tag never sent)', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub' })).toBe('ronni, sub');
  });

  it('spoken name is cleaned in the streak form same as the plain form', () => {
    expect(formatUtterance({ user: 'PikachuFan2012', kind: 'sub', streakMonths: 5 }))
      .toBe('PikachuFan, sub, 5 month streak');
  });

  it('a giftsub never speaks streak even if the field is somehow present (sub-kind-only gate)', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'giftsub', streakMonths: 5, amount: '3 gifts' }))
      .toBe('ronni, gift sub, 3 gifts');
  });

  it('omits when shouldShareStreak=false even with a nonzero streakMonths — the leak case: Twitch can send a real streak-months value alongside should-share-streak=0', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub', streakMonths: 5, shouldShareStreak: false }))
      .toBe('ronni, sub');
  });

  it('speaks when shouldShareStreak=true and streakMonths qualifies', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub', streakMonths: 5, shouldShareStreak: true }))
      .toBe('ronni, sub, 5 month streak');
  });

  it('speaks when shouldShareStreak is absent (tag never sent) and streakMonths qualifies — fail-open', () => {
    expect(formatUtterance({ user: 'ronni', kind: 'sub', streakMonths: 5 }))
      .toBe('ronni, sub, 5 month streak');
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

// ── cleanSpokenName — Step1 only (trailing digits, absorbing one preceding
// separator). Step2 (full trailing separator-segment strip, e.g. darc-ttv ->
// darc) is deferred and deliberately NOT implemented here — see the
// internal dry-run notes (2026-08-05).
describe('cleanSpokenName', () => {
  it('strips trailing digits stuck directly to the name', () => {
    expect(cleanSpokenName('PikachuFan2012')).toBe('PikachuFan');
  });

  it('absorbs the separator glued to trailing digits (whole _99, not just 99)', () => {
    expect(cleanSpokenName('cool_guy_99')).toBe('cool_guy');
    expect(cleanSpokenName('cool_guy_99')).not.toBe('cool_guy_');
  });

  it('leaves a name with no trailing digits unchanged, separator or not (Step2 territory)', () => {
    expect(cleanSpokenName('darc-ttv')).toBe('darc-ttv');
    expect(cleanSpokenName('RajGotcha')).toBe('RajGotcha');
  });

  it('guards an all-digit name — stripping to empty returns the original', () => {
    expect(cleanSpokenName('12345')).toBe('12345');
  });

  it('guards a 1-char remainder — returns the original, not the truncated stub', () => {
    expect(cleanSpokenName('A1')).toBe('A1');
  });

  it('leaves unicode/emoji names with no trailing digits untouched', () => {
    expect(cleanSpokenName('🔥StreamerName')).toBe('🔥StreamerName');
    expect(cleanSpokenName('こんにちは')).toBe('こんにちは');
  });

  it('never touches mid-name digits — only a trailing run', () => {
    expect(cleanSpokenName('2pac')).toBe('2pac');
    expect(cleanSpokenName('l33thax0r')).toBe('l33thax0r');
  });
});

// ── formatUtterance x cleanSpokenName — spoken cleaned, display (msg.user)
// untouched. Covers every financial kind's name slot: all of them carry the
// name in the same `user` field, so one loop over FINANCIAL_KINDS is full
// coverage, not a sampling shortcut.
describe('formatUtterance: spoken name cleaned, msg.user left untouched', () => {
  it.each([...FINANCIAL_KINDS])('kind=%s: spoken name is cleaned, msg.user is not mutated', (kind) => {
    const msg = { user: 'PikachuFan2012', kind };
    const spoken = formatUtterance(msg);
    expect(msg.user).toBe('PikachuFan2012'); // display source untouched
    expect(spoken.split(', ')[0]).toBe('PikachuFan'); // spoken name cleaned
  });

  it('a name with no trailing digits speaks and displays identically', () => {
    const msg = { user: 'RajGotcha', kind: 'cheer' };
    expect(formatUtterance(msg)).toBe('RajGotcha, cheer');
    expect(msg.user).toBe('RajGotcha');
  });
});

// ── ChatHub.pushMessage: tts_name_sep_candidate ────────────────────────────
describe('ChatHub.pushMessage: tts_name_sep_candidate log', () => {
  it('fires for a financial kind whose cleaned spoken name still has a separator', () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    hub.pushMessage('tw', { user: 'darc-ttv', kind: 'cheer' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"ev":"tts_name_sep_candidate"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"name":"darc-ttv"'));
    logSpy.mockRestore();
  });

  it('does not fire for a financial kind whose cleaned spoken name has no separator', () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    hub.pushMessage('tw', { user: 'RajGotcha', kind: 'cheer' });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('tts_name_sep_candidate'));
    logSpy.mockRestore();
  });

  it('does not fire for a separator-containing name on a non-financial (plain chat) row — never the general message path', () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    hub.pushMessage('tw', { user: 'darc-ttv', text: 'hello' }); // no kind — not financial

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('tts_name_sep_candidate'));
    logSpy.mockRestore();
  });

  it('a separator surviving only via digit-glue (post-Step1) still logs, e.g. mid-cleanup leftover', () => {
    const { hub } = makeHub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // cleanSpokenName('cool-guy_99') -> 'cool-guy' (digits+separator absorbed,
    // but the earlier separator survives) — exactly the Step2 candidate case.
    hub.pushMessage('tw', { user: 'cool-guy_99', kind: 'sub' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"name":"cool-guy"'));
    logSpy.mockRestore();
  });
});
