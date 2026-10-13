// Phone TTS speaker-button rules in the real PWA script (vm page driver):
// gold (alerts) always speaks; the speaker button toggles chat Gold <-> All.
// The mode-change announcement is not "speaking", so taps during it keep
// toggling; a tap while a chat or gold line is being read stops it, drops
// queued chat (queued gold survives) and lands on Gold.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import * as lib from '../src/lib.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'correct-secret' };

async function pwaScript() {
  const res = await worker.fetch(new Request('https://x/#t=correct-secret'), env, {});
  return (await res.text()).match(/<script>([\s\S]*?)<\/script>/)[1];
}

function fakeSynth() {
  const s = {
    spoken: [],
    cancels: 0,
    speaking: false,
    speak(u) { s.spoken.push(u); s.speaking = true; },
    cancel() { s.cancels++; s.speaking = false; },
    pause() {},
    resume() {},
  };
  return s;
}
class FakeUtterance { constructor(text) { this.text = text; } }

async function setup(localStorage = {}) {
  const synth = fakeSynth();
  // worker.js's formatUtterance (gold path) calls the lib.js import; unbundled,
  // vitest rewrites that to __vite_ssr_import_0__, which the vm sandbox lacks.
  const s = driveClientScriptSession(await pwaScript(), {
    localStorage, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance,
    extraGlobals: { __vite_ssr_import_0__: lib },
  });
  const btn = s.getElementById('speakToggle');
  const texts = () => synth.spoken.map((u) => u.text);
  return { synth, s, tap: () => btn._listeners.click(), texts, mode: () => btn.title };
}

const goldRow = (id, over = {}) => ({ id, platform: 'tw', user: 'Baller', login: 'baller', kind: 'cheer', amount: '500 bits', text: 'yo', twId: 'g' + id, ts: Date.now(), ...over });
const chatRow = (id, user = 'Alice', text = 'hello there') => ({ id, platform: 'tw', user, login: user.toLowerCase(), text, ts: Date.now() });

describe('TTS modes: gold is always on', () => {
  it('a fresh page is in Gold mode', async () => {
    const { mode } = await setup();
    expect(mode()).toBe('TTS: gold');
  });

  it('a stored off from an older client, and the legacy speak key, both land in Gold', async () => {
    expect((await setup({ 'multichat-tts-mode': 'off' })).mode()).toBe('TTS: gold');
    expect((await setup({ 'multichat-speak': 'off' })).mode()).toBe('TTS: gold');
  });

  it('a gold row speaks in Gold mode and in All mode', async () => {
    const g = await setup();
    g.s.fire(goldRow(7));
    expect(g.texts()).toEqual(['Baller, cheer, 500 bits']);
    const a = await setup({ 'multichat-tts-mode': 'all' });
    a.s.fire(goldRow(8));
    expect(a.texts()).toEqual(['Baller, cheer, 500 bits']);
  });

  it('a plain chat line is not spoken in Gold mode', async () => {
    const { s, texts } = await setup();
    s.fire(chatRow(9));
    expect(texts()).toEqual([]);
  });
});

describe('TTS speaker button: toggles Gold <-> All', () => {
  it('tap -> All announces, tap again -> Gold announces', async () => {
    const { tap, texts, mode, synth } = await setup();
    tap();
    expect(mode()).toBe('TTS: all');
    expect(texts()).toEqual(['read all chat on']);
    tap(); // during the first announcement: it is not "speaking"
    expect(mode()).toBe('TTS: gold');
    expect(texts()).toEqual(['read all chat on', 'read alerts on']);
    expect(synth.cancels).toBe(1); // the first announcement was cancelled
  });

  it('a stale end/error from the cancelled announcement does not advance or double-speak', async () => {
    const { tap, texts, synth } = await setup();
    tap();
    const first = synth.spoken[0];
    tap();
    first.onerror();
    first.onend();
    expect(texts()).toEqual(['read all chat on', 'read alerts on']);
    synth.spoken[1].onend();
    expect(texts()).toEqual(['read all chat on', 'read alerts on']);
  });

  it('there is no Off: any number of taps stays Gold or All', async () => {
    const { tap, mode, synth } = await setup();
    tap(); tap(); tap();
    expect(mode()).toBe('TTS: all');
    expect(synth.speaking).toBe(true);
  });

  it('taps after the announcement finished still toggle', async () => {
    const { tap, texts, mode, synth } = await setup();
    tap();
    synth.spoken[0].onend();
    tap();
    expect(mode()).toBe('TTS: gold');
    expect(texts()).toEqual(['read all chat on', 'read alerts on']);
  });
});

describe('TTS speaker button: tap while a line is being read', () => {
  it('chat speaking with chat + gold queued: tap stops chat, keeps gold, lands on Gold', async () => {
    const { s, tap, texts, mode, synth } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(chatRow(5));
    expect(texts()).toEqual(['Alice, hello there']);
    s.fire(chatRow(6, 'Bob', 'queued line'));
    s.fire(goldRow(7));
    const cancelsBefore = synth.cancels;
    tap();
    expect(mode()).toBe('TTS: gold');
    expect(synth.cancels).toBe(cancelsBefore + 1);
    expect(texts()).toEqual(['Alice, hello there', 'Baller, cheer, 500 bits']);
    synth.spoken[0].onend(); // stale end of the stopped chat line
    synth.spoken[1].onend();
    expect(texts()).toEqual(['Alice, hello there', 'Baller, cheer, 500 bits']); // Bob's line never spoken
  });

  it('gold line speaking in Gold mode: tap stops it and stays Gold', async () => {
    const { s, tap, texts, mode, synth } = await setup({ 'multichat-tts-mode': 'gold' });
    s.fire(goldRow(7));
    expect(texts()).toHaveLength(1);
    const cancelsBefore = synth.cancels;
    tap();
    expect(mode()).toBe('TTS: gold');
    expect(synth.cancels).toBe(cancelsBefore + 1);
  });

  it('a line queued behind an announcement does not make the next tap stop', async () => {
    const { s, tap, mode } = await setup();
    tap(); // All, announcing
    s.fire(goldRow(8, { amount: '5 bits' }));
    tap(); // announcement still current: toggles back to Gold
    expect(mode()).toBe('TTS: gold');
  });
});

describe('!tts mod command', () => {
  const modRow = (id, text) => ({ id, platform: 'tw', user: 'ModGuy', login: 'modguy', isMod: true, text, ts: Date.now() });
  const rowTexts = (s) => s.feed.children.map((r) => r.textContent);

  it('!tts off from a mod lands on Gold and gold still speaks', async () => {
    const { s, mode, texts } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(modRow(20, '!tts off'));
    expect(mode()).toBe('TTS: gold');
    expect(rowTexts(s).some((t) => t.includes('TTS gold by ModGuy'))).toBe(true);
    s.fire(goldRow(21));
    expect(texts()).toContain('Baller, cheer, 500 bits');
  });

  it('!tts off drops queued chat, keeps queued gold, does not cut the current line', async () => {
    const { s, mode, texts, synth } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(chatRow(40));
    s.fire(chatRow(41, 'Bob', 'queued line'));
    s.fire(goldRow(42));
    const cancelsBefore = synth.cancels;
    s.fire(modRow(43, '!tts off'));
    expect(mode()).toBe('TTS: gold');
    expect(synth.cancels).toBe(cancelsBefore);
    expect(texts()).toEqual(['Alice, hello there']);
    synth.spoken[0].onend();
    expect(texts()).toEqual(['Alice, hello there', 'Baller, cheer, 500 bits']);
    synth.spoken[1].onend();
    expect(texts()).toEqual(['Alice, hello there', 'Baller, cheer, 500 bits']);
  });

  it('!tts all switches to All', async () => {
    const { s, mode } = await setup();
    s.fire(modRow(22, '!tts all'));
    expect(mode()).toBe('TTS: all');
  });

  it('!tts gold is ignored: mode unchanged, no ttscmd row', async () => {
    const { s, mode } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(modRow(23, '!tts gold'));
    expect(mode()).toBe('TTS: all');
    expect(rowTexts(s).some((t) => t.includes('TTS gold by') || t.includes('TTS all by'))).toBe(false);
  });
});

describe('TTS bots in the real PWA script (All mode)', () => {
  const chat = (id, user, text = 'hello there') => ({ id, platform: 'tw', user, login: user.toLowerCase(), text, ts: Date.now() });

  it('bot lines are never spoken but their rows still display', async () => {
    const { s, texts } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(chat(1, 'Nightbot'));
    s.fire(chat(2, 'SomeNewBot'));
    s.fire(chat(3, 'Sery_Bot'));
    expect(texts()).toEqual([]);
    expect(s.feed.children).toHaveLength(3);
  });

  it('a normal name with bot mid-word is still spoken', async () => {
    const { s, texts } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(chat(4, 'Bottle'));
    expect(texts()).toEqual(['Bottle, hello there']);
  });

  it('an @mention in the body is spoken by the spoken-name rule', async () => {
    const { s, texts } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(chat(5, 'Viewer', '@RRR0O08B8 lol'));
    expect(texts()).toEqual(['Viewer, RRR lol']);
  });
});

describe('Read-Out-Loud redeem row in the real PWA script', () => {
  const readout = (id, over = {}) => ({ id, platform: 'tw', user: 'Viewer', login: 'viewer', text: 'read this shit', readAloud: true, twId: 'r' + id, ts: Date.now(), ...over });

  it('Gold mode: spoken exactly once, bleeped, and not again on a repeat id', async () => {
    const { s, texts } = await setup();
    s.fire(readout(30));
    expect(texts()).toEqual(['Viewer, read this bleep']);
    s.fire(readout(30));
    expect(texts()).toEqual(['Viewer, read this bleep']);
  });

  it('All mode: spoken exactly once, not also as plain chat', async () => {
    const { s, texts } = await setup({ 'multichat-tts-mode': 'all' });
    s.fire(readout(31));
    expect(texts()).toEqual(['Viewer, read this bleep']);
  });

  it('an emote-only redeem is not spoken; a URL is stripped', async () => {
    const { s, texts } = await setup();
    s.fire(readout(33, { text: 'Kappa', emotes: [{ id: '25', start: 0, end: 4 }], twId: 'r33' }));
    expect(texts()).toEqual([]);
    s.fire(readout(34, { text: 'see https://x.y/z now', twId: 'r34' }));
    expect(texts()).toEqual(['Viewer, see now']);
  });

  it('a bot account row is never spoken', async () => {
    const { s, texts } = await setup();
    s.fire(readout(32, { user: 'Streamlabs', login: 'streamlabs' }));
    expect(texts()).toEqual([]);
  });
});
