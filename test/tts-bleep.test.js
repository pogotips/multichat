import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import {
  bleepSpokenText, spokenNameFor, cleanSpokenMentions, parseExtraCurses, formatChatUtterance, readoutUtterance,
} from '../src/lib.js';

describe('bleepSpokenText', () => {
  it.each([
    ['what the fuck', 'what the bleep'],
    ['f*ck this sh1t', 'bleep this bleep'],
    ['f@ck', 'bleep'],
    ['FUCKING hell', 'bleep hell'],
    ['bitches', 'bleep'],
    ['you a55', 'you bleep'],
    ['shit!', 'bleep'],
  ])('%s -> %s', (input, out) => {
    expect(bleepSpokenText(input)).toBe(out);
  });
});

describe('false positives stay clean', () => {
  const FP = ['class', 'assassin', 'Scunthorpe', 'Dickens', 'Hancock', 'cocktail', 'shiitake', 'therapist', 'grape'];
  it.each(FP)('%s unchanged by bleepSpokenText', (w) => {
    expect(bleepSpokenText(w)).toBe(w);
  });
  it.each(FP)('%s is not "someone" via spokenNameFor', (w) => {
    expect(spokenNameFor(w)).toBe(w);
  });
  it('emails, asterisk runs and Cassie stay clean', () => {
    expect(bleepSpokenText('a@b.com')).toBe('a@b.com');
    expect(bleepSpokenText('***')).toBe('***');
    expect(spokenNameFor('Cassie')).toBe('Cassie');
  });
});

describe('cursing names', () => {
  it('speaks as someone', () => {
    expect(spokenNameFor('Sh1tLord99')).toBe('someone');
    expect(spokenNameFor('FuckFace')).toBe('someone');
    expect(spokenNameFor('Jon_123')).toBe('Jon');
    expect(cleanSpokenMentions('@FuckFace lol')).toBe('someone lol');
  });
});

describe('extra curses', () => {
  it('parseExtraCurses normalizes, drops short, dedupes', () => {
    expect(parseExtraCurses(' Zorp, blargh ,zorp,x ')).toEqual(['zorp', 'blargh']);
    expect(parseExtraCurses(undefined)).toEqual([]);
  });
  it('extends whole-word body and substring name matching', () => {
    expect(bleepSpokenText('zorp zorpy', ['zorp'])).toBe('bleep zorpy');
    expect(spokenNameFor('MrZorp', ['zorp'])).toBe('someone');
    expect(spokenNameFor('MrZorp')).toBe('MrZorp');
  });
});

describe('formatChatUtterance with curses', () => {
  it('bleeps body, someones both names', () => {
    expect(formatChatUtterance({ user: 'FuckFace', text: 'hi @Sh1tLord99 you shit' }))
      .toBe('someone, hi someone you bleep');
  });
});

describe('GET / embeds extra curses safely', () => {
  const fetchPage = async (extra) => {
    const env = { MULTICHAT_VIEW_SECRET: 'x' };
    if (extra !== undefined) env.MULTICHAT_TTS_EXTRA_CURSES = extra;
    return (await worker.fetch(new Request('https://x/'), env, {})).text();
  };
  it('embeds the parsed list and never the raw </script>', async () => {
    const page = await fetchPage('zorp,</script><script>alert(1)');
    const idx = page.indexOf('TTS_EXTRA_CURSES =');
    expect(idx).toBeGreaterThan(-1);
    expect(page.slice(idx, idx + 200)).toContain('"zorp"');
    expect(page.slice(idx)).not.toContain('</script><script>alert');
    const base = await fetchPage(undefined);
    const count = (s) => (s.match(/<script/g) || []).length;
    expect(count(page)).toBe(count(base));
  });
});

describe('digit-only tokens never bleep (F1)', () => {
  it.each(['455 views', '7175', '2024', '$5'])('%s unchanged', (t) => {
    expect(bleepSpokenText(t)).toBe(t);
  });
  it('letter-bearing leet still bleeps', () => {
    expect(bleepSpokenText('a55')).toBe('bleep');
    expect(bleepSpokenText('5h1t')).toBe('bleep');
  });
});

describe('username match is per name segment (F2)', () => {
  it.each(['YoshiTheDino', 'Michishita', 'Takeshita', 'Scunthorpe', 'Cassie', 'Dickens', 'snigger'])('%s stays', (n) => {
    expect(spokenNameFor(n)).toBe(n);
  });
  it.each(['ShitLord99', 'Sh1tLord', 'FuckFace', 'bigshit', 'shithead', 'xX_Fuck_Xx'])('%s -> someone', (n) => {
    expect(spokenNameFor(n)).toBe('someone');
  });
  it('extra curse matches a camel segment', () => {
    expect(spokenNameFor('MrZorp', ['zorp'])).toBe('someone');
  });
});

describe('body prefix rule is limited to real inflections (F3)', () => {
  it.each(['niggling', 'fire retardant', 'shiitake'])('%s unchanged', (t) => {
    expect(bleepSpokenText(t)).toBe(t);
  });
  it.each(['fucking', 'shitty', 'bitches', 'shithead', 'retarded', 'whores'])('%s bleeps', (t) => {
    expect(bleepSpokenText(t)).toBe('bleep');
  });
});

describe('readoutUtterance (F5)', () => {
  it('strips URLs from the body', () => {
    expect(readoutUtterance({ user: 'Name', text: 'see https://x.y/z now' })).toBe('Name, see now');
    expect(formatChatUtterance({ user: 'Name', text: 'see https://x.y/z now' })).toBe('Name, see now');
  });
  it('normal text unchanged', () => {
    expect(readoutUtterance({ user: 'Name', text: 'hello there' })).toBe('Name, hello there');
  });
  it('empty body (emote-only, or URL-only) yields an empty string', () => {
    expect(readoutUtterance({ user: 'Name', text: 'Kappa', emotes: [{ id: '25', start: 0, end: 4 }] })).toBe('');
    expect(readoutUtterance({ user: 'Name', text: 'https://x.y/z' })).toBe('');
  });
});
