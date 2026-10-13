import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import {
  nextTtsMode, chatSpeakSkipReason, formatChatUtterance, enqueueSpeechItem,
  parseTtsCommand, applyTtsCommand, cleanSpokenMentions, TTS_MODES, TTS_MODE_ICONS, TTS_BOT_NAMES, TTS_CHAT_TEXT_MAX, isTtsBotName,
} from '../src/lib.js';

const NOW = 1_000_000;
const OPTS = { myName: 'streamername', now: NOW, maxAgeMs: 20_000 };
const base = (over = {}) => ({ id: 1, platform: 'tw', user: 'Alice', login: 'alice', text: 'hello there', ts: NOW - 1000, ...over });

describe('nextTtsMode', () => {
  it('toggles gold <-> all', () => {
    expect(nextTtsMode('gold')).toBe('all');
    expect(nextTtsMode('all')).toBe('gold');
  });
  it('unknown (incl. a stored off) -> gold', () => {
    expect(nextTtsMode('off')).toBe('gold');
    expect(nextTtsMode('loud')).toBe('gold');
    expect(nextTtsMode(undefined)).toBe('gold');
  });
  it('the mode list has no off', () => {
    expect(TTS_MODES).toEqual(['gold', 'all']);
    expect(Object.keys(TTS_MODE_ICONS)).toEqual(['gold', 'all']);
  });
});

describe('chatSpeakSkipReason', () => {
  it('plain message is spoken', () => {
    expect(chatSpeakSkipReason(base(), OPTS)).toBeNull();
  });
  it.each([
    ['sys', { sys: 'info' }],
    ['gold', { kind: 'cheer' }],
    ['replay', { replay: true }],
    ['replay', { recovered: true }],
    ['deleted', { deleted: true }],
    ['deleted', { superseded: true }],
    ['stale', { ts: NOW - 25_000 }],
    ['stale', { ts: undefined }],
    ['self', { login: 'streamername', user: 'StreamerName' }],
    ['self', { login: 'other', user: 'StreamerName' }],
    ['command', { text: '!so x' }],
    ['command', { text: '  !tts all' }],
    ['link', { text: 'see https://example.com/x' }],
    ['link', { text: 'see www.example.com' }],
    ['emote_only', { text: 'Kappa', emotes: [{ id: '25', start: 0, end: 4 }] }],
    ['emote_only', { text: undefined }],
  ])('%s', (reason, over) => {
    expect(chatSpeakSkipReason(base(over), OPTS)).toBe(reason);
  });
  it('normalizes @, verified tick and case before the bot check (live YT row)', () => {
    const yt = { platform: 'yt', user: '@Streamlabs\u2713', text: 'Thanks!', ts: NOW };
    expect(chatSpeakSkipReason(yt, OPTS)).toBe('bot');
  });
  it('Twitch streamlabs row is a bot (pin, green before the change)', () => {
    const tw = { platform: 'tw', login: 'streamlabs', user: 'Streamlabs', text: 'hi', ts: NOW };
    expect(chatSpeakSkipReason(tw, OPTS)).toBe('bot');
  });
  it('padded @NightBot is a bot', () => {
    expect(chatSpeakSkipReason(base({ login: 'x', user: ' @NightBot ' }), OPTS)).toBe('bot');
  });
  it('every listed bot name, @-prefixed and capitalized, is a bot', () => {
    for (const b of TTS_BOT_NAMES) {
      const cap = '@' + b.charAt(0).toUpperCase() + b.slice(1);
      expect(chatSpeakSkipReason(base({ login: 'y', user: cap }), OPTS)).toBe('bot');
    }
  });
  it('@Bottle is not a bot', () => {
    expect(chatSpeakSkipReason(base({ login: 'bottle', user: '@Bottle' }), OPTS)).toBeNull();
  });
  it('future ts is not stale', () => {
    expect(chatSpeakSkipReason(base({ ts: NOW + 5000 }), OPTS)).toBeNull();
  });
  it('each bot name is skipped via login and via user', () => {
    for (const b of TTS_BOT_NAMES) {
      expect(chatSpeakSkipReason(base({ login: b, user: 'x' }), OPTS)).toBe('bot');
      expect(chatSpeakSkipReason(base({ login: 'y', user: b.toUpperCase() }), OPTS)).toBe('bot');
    }
    expect(TTS_BOT_NAMES).toHaveLength(14);
  });
  it.each([
    'Nightbot', 'StreamElements', 'Streamlabs', 'Moobot', 'Fossabot', 'Wizebot', 'Sery_Bot', 'PhantomBot',
    'Botisimo', 'DeepBot', 'Coebot', 'SoundAlerts', 'KoFiStreamBot', 'PokemonCommunityGame',
  ])('listed bot %s is skipped by login and by display name, any case', (name) => {
    expect(chatSpeakSkipReason(base({ login: name.toLowerCase(), user: 'x' }), OPTS)).toBe('bot');
    expect(chatSpeakSkipReason(base({ login: 'y', user: name }), OPTS)).toBe('bot');
    expect(chatSpeakSkipReason(base({ login: 'y', user: name.toUpperCase() }), OPTS)).toBe('bot');
  });
  it.each(['SomeNewBot', 'cool_bot', 'RoBoT', 'Robot', 'x_BOT '])('name ending in bot (%s) is skipped', (name) => {
    expect(chatSpeakSkipReason(base({ login: 'y', user: name }), OPTS)).toBe('bot');
    expect(chatSpeakSkipReason(base({ login: name, user: 'Someone' }), OPTS)).toBe('bot');
  });
  it.each(['Bottle', 'Botanist', 'abotc', 'Boto', 'bot_fan', 'Alice'])('name with bot not at the end (%s) is still spoken', (name) => {
    expect(chatSpeakSkipReason(base({ login: name.toLowerCase(), user: name }), OPTS)).toBeNull();
  });
  it('isTtsBotName handles empty and non-string input', () => {
    expect(isTtsBotName('')).toBe(false);
    expect(isTtsBotName(undefined)).toBe(false);
    expect(isTtsBotName(null)).toBe(false);
  });
  it('reason order: sys beats gold beats replay', () => {
    expect(chatSpeakSkipReason(base({ sys: 'x', kind: 'sub', replay: true }), OPTS)).toBe('sys');
    expect(chatSpeakSkipReason(base({ kind: 'sub', replay: true }), OPTS)).toBe('gold');
    expect(chatSpeakSkipReason(base({ replay: true, deleted: true }), OPTS)).toBe('replay');
  });
  it('double spaces from emote removal are not a link', () => {
    expect(chatSpeakSkipReason(base({ text: 'hi  there' }), OPTS)).toBeNull();
  });
});

describe('formatChatUtterance', () => {
  it('strips emotes and cleans the name', () => {
    const m = base({ user: 'Alice_99', text: 'Kappa hello', emotes: [{ id: '25', start: 0, end: 4 }] });
    const out = formatChatUtterance(m);
    expect(out.endsWith(', hello')).toBe(true);
    expect(out).not.toContain('Kappa');
  });
  it('caps body at 200 chars', () => {
    const out = formatChatUtterance(base({ text: 'a'.repeat(500) }));
    expect(out.length).toBeLessThanOrEqual(TTS_CHAT_TEXT_MAX + 40);
    expect(out.split(', ').slice(1).join(', ').length).toBe(TTS_CHAT_TEXT_MAX);
  });
});

describe('cleanSpokenMentions', () => {
  it.each([
    ['@RRR0O08B8 lol', 'RRR lol'],
    ['hi @wiccedrasta9981!', 'hi wiccedrasta!'],
    ['mail me a@b.com', 'mail me a@b.com'],
    ['@x9z8 hey', 'someone hey'],
    ['no mentions here', 'no mentions here'],
    ['@Jon_123, @AIRBRAKE_88', 'Jon, AIRBRAKE'],
  ])('%s -> %s', (input, expected) => {
    expect(cleanSpokenMentions(input)).toBe(expected);
  });
  it('formatChatUtterance speaks mentions by the spoken-name rule', () => {
    expect(formatChatUtterance({ user: 'Viewer', text: '@RRR0O08B8 lol' })).toBe('Viewer, RRR lol');
  });
});

describe('enqueueSpeechItem', () => {
  const g = (t) => ({ text: t, gold: true });
  const c = (t) => ({ text: t, gold: false });
  it('gold jumps ahead of chat but behind earlier gold', () => {
    const q = [g('g1'), c('c1'), c('c2')];
    expect(enqueueSpeechItem(q, g('g2'), 5).map((i) => i.text)).toEqual(['g1', 'g2', 'c1', 'c2']);
  });
  it('chat goes to the end', () => {
    expect(enqueueSpeechItem([g('g1')], c('c1'), 5).map((i) => i.text)).toEqual(['g1', 'c1']);
  });
  it('over cap drops the oldest chat first', () => {
    const q = [g('g1'), c('c1'), c('c2'), c('c3'), c('c4')];
    expect(enqueueSpeechItem(q, c('c5'), 5).map((i) => i.text)).toEqual(['g1', 'c2', 'c3', 'c4', 'c5']);
  });
  it('all-gold over cap drops index 0', () => {
    const q = [g('1'), g('2'), g('3'), g('4'), g('5')];
    expect(enqueueSpeechItem(q, g('6'), 5).map((i) => i.text)).toEqual(['2', '3', '4', '5', '6']);
  });
  it('does not mutate the input', () => {
    const q = [c('c1')];
    const out = enqueueSpeechItem(q, g('g1'), 5);
    expect(out).not.toBe(q);
    expect(q).toHaveLength(1);
  });
});

describe('parseTtsCommand', () => {
  const o = { now: NOW, maxAgeMs: 20_000 };
  const mod = (over = {}) => base({ isMod: true, text: '!tts all', ...over });
  it('mod applies, case-insensitive, trailing spaces', () => {
    expect(parseTtsCommand(mod(), o)).toBe('all');
    expect(parseTtsCommand(mod({ text: '!TTS All  ' }), o)).toBe('all');
    expect(parseTtsCommand(mod({ text: '!tts on' }), o)).toBe('on');
    expect(parseTtsCommand(mod({ text: '!tts off' }), o)).toBe('off');
  });
  it('rejects non-mods', () => {
    expect(parseTtsCommand(mod({ isMod: undefined }), o)).toBeNull();
    expect(parseTtsCommand(mod({ isMod: false }), o)).toBeNull();
  });
  it('rejects replay, recovered, stale, sys', () => {
    expect(parseTtsCommand(mod({ replay: true }), o)).toBeNull();
    expect(parseTtsCommand(mod({ recovered: true }), o)).toBeNull();
    expect(parseTtsCommand(mod({ ts: NOW - 21_000 }), o)).toBeNull();
    expect(parseTtsCommand(mod({ sys: 'info' }), o)).toBeNull();
  });
  it('rejects unknown args and malformed commands', () => {
    expect(parseTtsCommand(mod({ text: '!tts gold' }), o)).toBeNull();
    expect(parseTtsCommand(mod({ text: '!tts loud' }), o)).toBeNull();
    expect(parseTtsCommand(mod({ text: '!tts' }), o)).toBeNull();
    expect(parseTtsCommand(mod({ text: '!ttsall' }), o)).toBeNull();
    expect(parseTtsCommand(null, o)).toBeNull();
  });
});

describe('applyTtsCommand', () => {
  it('off -> gold (gold never turns off)', () => {
    expect(applyTtsCommand('off')).toBe('gold');
  });
  it('on and all -> all', () => {
    expect(applyTtsCommand('on')).toBe('all');
    expect(applyTtsCommand('all')).toBe('all');
  });
});

describe('TTS modes page wiring', () => {
  const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y' };
  it('PWA has the mode machinery', async () => {
    const html = await (await worker.fetch(new Request('https://x/#t=x'), env, {})).text();
    for (const s of ['TTS_MODE_KEY', 'function nextTtsMode(', 'function chatSpeakSkipReason(', 'function enqueueSpeechItem(', 'function markMatchesQueueItem(', 'ttsCmdSeen', 'parseTtsCommand(']) {
      expect(html).toContain(s);
    }
    expect(html).not.toContain('speakEnabled');
    expect(html).not.toContain('ttsLastOn');
    expect(html).not.toContain("'multichat-speak'");
  });
  it('stopSpeaking guards a missing speechSynthesis; setTtsMode starts the keepalive in every mode', async () => {
    const html = await (await worker.fetch(new Request('https://x/#t=x'), env, {})).text();
    const fn = (name) => {
      const i = html.indexOf('function ' + name + '(');
      expect(i).toBeGreaterThan(-1);
      return html.slice(i, html.indexOf('\n  }\n', i) + 4);
    };
    expect(fn('stopSpeaking')).toContain('if (window.speechSynthesis)');
    expect(html).toContain('function stopChatSpeech(');
    const body = fn('setTtsMode');
    const keep = body.indexOf('startKeepalive()');
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(body.indexOf('if (announce)'));
  });
  it('overlay has no phone-mode code', async () => {
    const html = await (await worker.fetch(new Request('https://x/overlay?t=y'), env, {})).text();
    expect(html).not.toContain('ttsCmdSeen');
    expect(html).not.toContain('parseTtsCommand(');
  });
});
