// Spoken @mentions + spoken word map (MULTICHAT_TTS_SAY_AS). Speech only:
// display text is never rewritten. Stand-in names only (no real brand strings).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cleanSpokenName, cleanSpokenMentions, applySpokenWordMap, parseSayAsMap,
  spokenNameFor, spokenSenderName, formatChatUtterance, readoutUtterance,
  formatOverlayChatUtterance, sanitizeSpokenBody, chatSpeakSkipReason,
  bleepSpokenText,
} from '../src/lib.js';
import worker, { formatUtterance, formatOverlayUtterance } from '../src/worker.js';

const MAP = { Word: 'wurd', WordOfficial: 'wurd official', A: 'ay', AB: 'ay bee' };

// Handles the parity pins run over. All stand-ins.
const HANDLES = ['Some_Name-x9k', 'Name_42', 'darc-ttv', 'ab12345', 'Word_2'];

describe('cleanSpokenMentions: whole handle reaches the spoken-name rule', () => {
  it.each(HANDLES)('"@%s" is spoken exactly like the sender name %s', (h) => {
    const expected = cleanSpokenName(h);
    expect(cleanSpokenMentions('@' + h)).toBe(expected);
    expect(spokenNameFor(h)).toBe(expected);
  });

  it('keeps trailing punctuation after cleanup', () => {
    expect(cleanSpokenMentions('@Some_Name-x9k,')).toBe(cleanSpokenName('Some_Name-x9k') + ',');
    expect(cleanSpokenMentions('@Name_42!')).toBe(cleanSpokenName('Name_42') + '!');
    expect(cleanSpokenMentions('hey @Name_42?! ok')).toBe('hey ' + cleanSpokenName('Name_42') + '?! ok');
  });

  it('the 2-letter guard still applies ("ab-123" -> someone, punctuation kept)', () => {
    expect(cleanSpokenName('ab-123')).toBe('someone');
    expect(cleanSpokenMentions('@ab-123.')).toBe('someone.');
  });

  it('leaves emails, mid-word @ and hyphenated plain words untouched', () => {
    expect(cleanSpokenMentions('mail me at a@b.co')).toBe('mail me at a@b.co');
    expect(cleanSpokenMentions('well-known')).toBe('well-known');
    expect(cleanSpokenMentions('a well-known @Name_42')).toBe('a well-known ' + cleanSpokenName('Name_42'));
    expect(cleanSpokenMentions('foo@Name_42')).toBe('foo@Name_42');
  });

  it('a bare "@" or "@!!" is left as typed', () => {
    expect(cleanSpokenMentions('@ hi')).toBe('@ hi');
    expect(cleanSpokenMentions('@!! hi')).toBe('@!! hi');
  });

  it('still bleeps a curse-name mention to "someone" (spokenNameFor path)', () => {
    expect(cleanSpokenMentions('@FuckFace-1 lol')).toBe('someone lol');
  });
});

describe('applySpokenWordMap', () => {
  it('bare word, mixed case, trailing "!"', () => {
    expect(applySpokenWordMap('hello Word', MAP)).toBe('hello wurd');
    expect(applySpokenWordMap('hello WORD and word and wOrD!', MAP)).toBe('hello wurd and wurd and wurd!');
  });

  it('key A never matches inside longer key AB or any longer word', () => {
    expect(applySpokenWordMap('AB', MAP)).toBe('ay bee');
    expect(applySpokenWordMap('ABC', MAP)).toBe('ABC');
    expect(applySpokenWordMap('A AB ABC cab', MAP)).toBe('ay ay bee ABC cab');
    expect(applySpokenWordMap('a-b', MAP)).toBe('ay-b'); // "-" is a boundary, so lone A is a whole word here
  });

  it('does not match inside a longer word, and a mapped form is not rescanned', () => {
    expect(applySpokenWordMap('Wordsmith Sword', { Word: 'wurd' })).toBe('Wordsmith Sword');
    expect(applySpokenWordMap('Word', { Word: 'Word Word' })).toBe('Word Word');
    expect(applySpokenWordMap('x', { x: 'y', y: 'z' })).toBe('y');
  });

  it('"-" "." and punctuation are boundaries', () => {
    expect(applySpokenWordMap('WordOfficial-xy', MAP)).toBe('wurd official-xy');
    expect(applySpokenWordMap('(Word).', MAP)).toBe('(wurd).');
  });

  it('empty, missing and malformed maps are no-ops', () => {
    expect(applySpokenWordMap('Word', {})).toBe('Word');
    expect(applySpokenWordMap('Word', undefined)).toBe('Word');
    expect(applySpokenWordMap('Word', null)).toBe('Word');
    expect(applySpokenWordMap('Word', { Word: 5 })).toBe('Word');
    expect(applySpokenWordMap(undefined, MAP)).toBe('');
  });

  it('regex metacharacters in a key are literal', () => {
    expect(applySpokenWordMap('a.b and axb', { 'a.b': 'dot' })).toBe('dot and axb');
    expect(applySpokenWordMap('x', { '(': 'p', '[': 'q', '\\': 'r', 'a|b': 's' })).toBe('x');
  });
});

describe('word map in every speech slot (PWA and overlay builders)', () => {
  const chat = (user, text) => ({ user, login: String(user).toLowerCase(), text });

  it('as sender name', () => {
    expect(formatChatUtterance(chat('Word', 'hi'), undefined, MAP)).toBe('wurd, hi');
    expect(formatChatUtterance(chat('wORD', 'hi'), undefined, MAP)).toBe('wurd, hi');
    expect(formatOverlayChatUtterance(chat('Word', 'hi'), undefined, MAP)).toBe('wurd says hi');
    expect(formatUtterance({ user: 'Word', kind: 'cheer', amount: '5 bits' }, undefined, MAP)).toBe('wurd, cheer, 5 bits');
    expect(spokenSenderName('Word', undefined, MAP)).toBe('wurd');
  });

  it('as bare word in the body, with "!"', () => {
    expect(formatChatUtterance(chat('Viewer', 'love Word!'), undefined, MAP)).toBe('Viewer, love wurd!');
    expect(formatOverlayChatUtterance(chat('Viewer', 'love word!'), undefined, MAP)).toBe('Viewer says love wurd!');
    expect(readoutUtterance(chat('Viewer', 'read WORD'), undefined, MAP)).toBe('Viewer, read wurd');
  });

  it('as "@Word_2" mention', () => {
    expect(formatChatUtterance(chat('Viewer', 'hi @Word_2'), undefined, MAP)).toBe('Viewer, hi wurd');
    expect(formatOverlayChatUtterance(chat('Viewer', 'hi @Word_2!'), undefined, MAP)).toBe('Viewer says hi wurd!');
  });

  it('as "@WordOfficial-ab1" mention and sender (same path, same result)', () => {
    const spoken = applySpokenWordMap(cleanSpokenName('WordOfficial-ab1'), MAP);
    expect(spoken).toContain('wurd official');
    expect(formatChatUtterance(chat('Viewer', 'hi @WordOfficial-ab1'), undefined, MAP)).toBe('Viewer, hi ' + spoken);
    expect(formatChatUtterance(chat('WordOfficial-ab1', 'hi'), undefined, MAP)).toBe(spoken + ', hi');
  });

  it('financial-body path (sanitizeSpokenBody / formatOverlayUtterance)', () => {
    expect(sanitizeSpokenBody('thanks @Word_2 and Word', 120, undefined, MAP)).toBe('thanks wurd and wurd');
    const msg = { user: 'Word', kind: 'cheer', amount: '5 bits', text: 'hi @Name_42' };
    expect(formatOverlayUtterance(msg, { speakBody: true, sayAs: MAP }))
      .toBe('wurd, cheer, 5 bits, hi ' + cleanSpokenName('Name_42'));
  });

  it('no map (undefined / {}) is byte-identical to the old output for the same input', () => {
    const msg = chat('Viewer', 'hi @Name_42 Word');
    expect(formatChatUtterance(msg)).toBe(formatChatUtterance(msg, undefined, {}));
    expect(formatOverlayChatUtterance(msg)).toBe('Viewer says hi ' + cleanSpokenName('Name_42') + ' Word');
  });
});

describe('@mention parity: body mention speech equals sender speech, PWA and overlay', () => {
  it.each(HANDLES)('%s', (h) => {
    const n = cleanSpokenName(h);
    // PWA line
    expect(formatChatUtterance({ user: 'Viewer', text: '@' + h })).toBe('Viewer, ' + n);
    expect(formatChatUtterance({ user: h, text: 'hi' })).toBe(n + ', hi');
    // overlay line
    expect(formatOverlayChatUtterance({ user: 'Viewer', text: '@' + h })).toBe('Viewer says ' + n);
    expect(formatOverlayChatUtterance({ user: h, text: 'hi' })).toBe(n + ' says hi');
    // financial body
    expect(sanitizeSpokenBody('@' + h)).toBe(n);
  });
});

describe('curse bleep and bot-skip unchanged', () => {
  it('body curses still bleep with the map active; a mapped form is not bleeped away', () => {
    expect(formatChatUtterance({ user: 'Viewer', text: 'what the fuck Word' }, undefined, MAP)).toBe('Viewer, what the bleep wurd');
    expect(bleepSpokenText('shit')).toBe('bleep');
  });

  it('curse sender name is still "someone", on the overlay too', () => {
    expect(formatChatUtterance({ user: 'FuckFace', text: 'hi' }, undefined, MAP)).toBe('someone, hi');
    expect(formatOverlayChatUtterance({ user: 'FuckFace', text: 'hi' }, undefined, MAP)).toBe('someone says hi');
  });

  it('extra curses reach the overlay name check', () => {
    expect(formatOverlayChatUtterance({ user: 'Zork', text: 'hi' }, ['zork'], MAP)).toBe('someone says hi');
  });

  it('bot rows are still skipped (map irrelevant)', () => {
    const now = Date.now();
    const base = { platform: 'tw', text: 'hello', ts: now };
    expect(chatSpeakSkipReason({ ...base, user: 'Nightbot', login: 'nightbot' }, { now, maxAgeMs: 20_000, myName: '' })).toBe('bot');
    expect(chatSpeakSkipReason({ ...base, user: 'Viewer', login: 'viewer' }, { now, maxAgeMs: 20_000, myName: '' })).toBeNull();
  });
});

describe('parseSayAsMap', () => {
  it('unset / empty = empty map, no bad flag', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const r = parseSayAsMap(raw);
      expect(Object.keys(r.map)).toEqual([]);
      expect(r.bad).toBeNull();
    }
  });

  it('bad JSON and non-objects = empty map plus a reason code', () => {
    expect(parseSayAsMap('{not json')).toMatchObject({ bad: 'not_json' });
    expect(parseSayAsMap('[1,2]')).toMatchObject({ bad: 'not_object' });
    expect(parseSayAsMap('"str"')).toMatchObject({ bad: 'not_object' });
    expect(parseSayAsMap('null')).toMatchObject({ bad: 'not_object' });
    expect(Object.keys(parseSayAsMap('{nope').map)).toEqual([]);
  });

  it('keeps string entries, drops junk, caps lengths and count, strips control chars', () => {
    const big = {};
    for (let i = 0; i < 250; i++) big['k' + i] = 'v' + i;
    expect(Object.keys(parseSayAsMap(JSON.stringify(big)).map)).toHaveLength(200);
    const r = parseSayAsMap(JSON.stringify({ Word: 'wu\u0000rd', '': 'x', Empty: '  ', Num: 3, [`L${'x'.repeat(70)}`]: 'long key', Long: 'y'.repeat(100) }));
    expect(r.map.Word).toBe('wurd');
    expect(Object.keys(r.map).sort()).toEqual(['Long', 'Word']);
    expect(r.map.Long).toHaveLength(64);
  });

  it('a "__proto__" key is just a key', () => {
    const r = parseSayAsMap('{"__proto__":"pwn","Word":"wurd"}');
    expect(Object.getPrototypeOf(r.map)).toBeNull();
    expect({}.pwn).toBeUndefined();
    expect(applySpokenWordMap('Word', r.map)).toBe('wurd');
  });
});

describe('Worker injects the map into both pages (JSON-encoded, "<" escaped)', () => {
  const baseEnv = { MULTICHAT_VIEW_SECRET: 'v', MULTICHAT_OVERLAY_SECRET: 'o' };
  const grab = async (url, env) => (await worker.fetch(new Request(url), { ...baseEnv, ...env }, {})).text();

  it('PWA and overlay carry the map; a "</script>" value cannot break out', async () => {
    const raw = JSON.stringify({ Word: 'wurd', '</script><b>': 'x</script>' });
    for (const url of ['https://x/', 'https://x/overlay?t=o']) {
      const html = await grab(url, { MULTICHAT_TTS_SAY_AS: raw });
      expect(html).toContain('const TTS_SAY_AS = {"Word":"wurd",');
      expect(html).toContain('\\u003c/script>');
      expect(html.match(/<\/script>/g)).toHaveLength(1); // only the page's own closing tag
    }
  });

  it('unset gives an empty map on both pages', async () => {
    for (const url of ['https://x/', 'https://x/overlay?t=o']) {
      expect(await grab(url, {})).toContain('const TTS_SAY_AS = {};');
    }
  });

  it('a changed secret value is picked up by the memoized PWA page', async () => {
    const a = await grab('https://x/', { MULTICHAT_TTS_SAY_AS: '{"Word":"one"}' });
    const b = await grab('https://x/', { MULTICHAT_TTS_SAY_AS: '{"Word":"two"}' });
    expect(a).toContain('"Word":"one"');
    expect(b).toContain('"Word":"two"');
  });
});

describe('bad config logs one reason-only ev per isolate', () => {
  beforeEach(() => { vi.resetModules(); });

  it('bad JSON: empty map, exactly one ev, value never logged', async () => {
    const secretish = '{"Word":"hunter2-not-json';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const fresh = (await import('../src/worker.js?isolate=1')).default;
      const env = { MULTICHAT_VIEW_SECRET: 'v', MULTICHAT_OVERLAY_SECRET: 'o', MULTICHAT_TTS_SAY_AS: secretish };
      for (let i = 0; i < 3; i++) {
        const html = await (await fresh.fetch(new Request('https://x/overlay?t=o'), env, {})).text();
        expect(html).toContain('const TTS_SAY_AS = {};');
      }
      await (await fresh.fetch(new Request('https://x/'), env, {})).text();
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('tts_say_as_bad_config'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ ev: 'tts_say_as_bad_config', reason: 'not_json' });
      expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('hunter2');
    } finally {
      spy.mockRestore();
    }
  });

  it('unset logs nothing', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const fresh = (await import('../src/worker.js?isolate=2')).default;
      await (await fresh.fetch(new Request('https://x/'), { MULTICHAT_VIEW_SECRET: 'v' }, {})).text();
      expect(spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('tts_say_as'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
