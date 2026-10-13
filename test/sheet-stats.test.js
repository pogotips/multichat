import { describe, it, expect, vi } from 'vitest';
import worker from '../src/worker.js';
import {
  parseAmountNumber, splitAmountCurrency, summarizeGold, sheetStats, copyHandle, writeClipboard,
} from '../src/lib.js';

describe('parseAmountNumber', () => {
  it.each([
    ['1,500 bits', 1500],
    ['$5.00', 5],
    ['€2,00', 2],
    ['¥500', 500],
    ['5 gifts', 5],
    ['CA$12.50', 12.5],
    ['abc', null],
    ['1.2.3 and 4', null],
    ['', null],
    [undefined, null],
  ])('%j -> %j', (input, expected) => {
    expect(parseAmountNumber(input)).toBe(expected);
  });
});

describe('splitAmountCurrency', () => {
  it('splits prefix currency', () => {
    expect(splitAmountCurrency('CA$12.50')).toEqual({ prefix: 'CA$', suffix: '', num: 12.5, decimals: 2 });
  });
  it('splits suffix currency with decimal comma', () => {
    expect(splitAmountCurrency('5,00 €')).toEqual({ prefix: '', suffix: '€', num: 5, decimals: 2 });
  });
  it('non-string is empty', () => {
    expect(splitAmountCurrency(undefined)).toEqual({ prefix: '', suffix: '', num: null, decimals: 0 });
  });
  it('thousands separator is not decimals', () => {
    expect(splitAmountCurrency('1,500 bits').decimals).toBe(0);
  });
});

describe('summarizeGold', () => {
  it('sums cheers as bits', () => {
    const out = summarizeGold([
      { kind: 'cheer', amount: '100 bits' },
      { kind: 'cheer', amount: '1,500 bits' },
    ]);
    expect(out).toEqual(['2× cheer (1600 bits)']);
  });
  it('sums one currency into one entry', () => {
    const out = summarizeGold([
      { kind: 'superchat', amount: '$5.00' },
      { kind: 'superchat', amount: '$2.50' },
    ]);
    expect(out).toEqual(['2× superchat ($7.50)']);
  });
  it('never sums across currencies', () => {
    const out = summarizeGold([
      { kind: 'superchat', amount: '$5.00' },
      { kind: 'superchat', amount: '¥500' },
    ]);
    expect(out).toEqual(['1× superchat ($5.00)', '1× superchat (¥500)']);
  });
  it('unparseable amount in a group falls back to raw join', () => {
    const out = summarizeGold([
      { kind: 'superchat', amount: '$5.00' },
      { kind: 'superchat', amount: '$1.2.3' },
    ]);
    expect(out).toEqual(['2× superchat ($5.00 + $1.2.3)']);
  });
  it('excludes member_gift_received and kindless rows', () => {
    const out = summarizeGold([
      { kind: 'member_gift_received', amount: '1' },
      { text: 'hi' },
      { kind: 'sub' },
    ]);
    expect(out).toEqual(['1× sub']);
  });
  it('counts deleted gold rows', () => {
    expect(summarizeGold([{ kind: 'cheer', amount: '50 bits', deleted: true }])).toEqual(['1× cheer (50 bits)']);
  });
  it('lists yt_gift names, capped at 3 then an ellipsis', () => {
    expect(summarizeGold([
      { kind: 'yt_gift', amount: 'Rose' },
      { kind: 'yt_gift', amount: 'Rose' },
      { kind: 'yt_gift', amount: 'Heart' },
    ])).toEqual(['3× gift (Rose, Heart)']);
    expect(summarizeGold(['A', 'B', 'C', 'D'].map((a) => ({ kind: 'yt_gift', amount: a }))))
      .toEqual(['4× gift (A, B, C, …)']);
  });
  it('giftsub with no amount counts one gift', () => {
    expect(summarizeGold([{ kind: 'giftsub' }, { kind: 'giftsub', amount: '5 gifts' }]))
      .toEqual(['2× gift sub (6 gifts)']);
  });
  it('uses a stable kind order', () => {
    const out = summarizeGold([{ kind: 'sub' }, { kind: 'cheer', amount: '10' }]);
    expect(out).toEqual(['1× cheer (10 bits)', '1× sub']);
  });
  it('empty -> []', () => {
    expect(summarizeGold([])).toEqual([]);
  });
});

describe('sheetStats', () => {
  it('counts, finds min ts, passes gold through', () => {
    const s = sheetStats([{ ts: 300 }, { ts: 100, kind: 'sub' }, { ts: 200 }]);
    expect(s).toEqual({ count: 3, firstTs: 100, gold: ['1× sub'] });
  });
  it('empty', () => {
    expect(sheetStats([])).toEqual({ count: 0, firstTs: null, gold: [] });
  });
});

describe('copyHandle', () => {
  it('twitch lowercases login and strips @', () => {
    expect(copyHandle('tw', 'Bob_1', 'Bob_1')).toBe('bob_1');
    expect(copyHandle('tw', '@Bob', 'x')).toBe('bob');
  });
  it('youtube uses display name without leading @', () => {
    expect(copyHandle('yt', undefined, '@Alice')).toBe('Alice');
    expect(copyHandle('yt', undefined, '@@Alice')).toBe('Alice');
  });
  it('unknown cases are empty', () => {
    expect(copyHandle('tw', undefined, 'x')).toBe('');
    expect(copyHandle('zz', 'a', 'b')).toBe('');
  });
});

describe('writeClipboard', () => {
  it('uses navigator.clipboard when it works', async () => {
    const nav = { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } };
    const doc = { execCommand: vi.fn() };
    expect(await writeClipboard('@bob', nav, doc)).toBe(true);
    expect(nav.clipboard.writeText).toHaveBeenCalledWith('@bob');
    expect(doc.execCommand).not.toHaveBeenCalled();
  });
  it('falls back to execCommand when writeText rejects', async () => {
    const ta = { select: vi.fn(), remove: vi.fn(), value: '' };
    const doc = {
      createElement: vi.fn(() => ta),
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => true),
    };
    const nav = { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } };
    expect(await writeClipboard('!so bob', nav, doc)).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(ta.value).toBe('!so bob');
    expect(ta.remove).toHaveBeenCalled();
  });
  it('returns false (never throws) when everything fails', async () => {
    const ta = { select: vi.fn(), remove: vi.fn() };
    const doc = {
      createElement: () => ta,
      body: { appendChild: () => {} },
      execCommand: () => { throw new Error('nope'); },
    };
    await expect(writeClipboard('x', {}, doc)).resolves.toBe(false);
  });
});

describe('sheet stats page wiring', () => {
  const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };
  it('PWA carries markup and helpers', async () => {
    const html = await (await worker.fetch(new Request('https://x/#t=x'), env, {})).text();
    for (const s of ['id="sheetStats"', 'id="copyAt"', 'function sheetStats(', 'function writeClipboard(', 'function copyHandle(']) {
      expect(html).toContain(s);
    }
  });
  it('PWA has no !so copy button', async () => {
    const html = await (await worker.fetch(new Request('https://x/#t=x'), env, {})).text();
    expect(html).not.toContain('id="copySo"');
  });
  it('overlay carries none of it', async () => {
    const html = await (await worker.fetch(new Request('https://x/overlay?t=y'), env, {})).text();
    expect(html).not.toContain('sheetStats');
    expect(html).not.toContain('copyAt');
  });
});
