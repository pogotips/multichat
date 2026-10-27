// PWA TTS mute button in the real PWA script (vm page driver): muted = no
// speech at all (in-flight line cancelled on tap), buzz unaffected, the
// Gold/All speaker mode untouched, and the spoken-id floor + spoken set keep
// advancing so unmute never dumps a backlog. Also: a Read-Out-Loud row buzzes.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import * as lib from '../src/lib.js';
import { driveClientScriptSession } from './helpers/vm-page-driver.mjs';

const env = { MULTICHAT_VIEW_SECRET: 'correct-secret' };

async function pageHtml() {
  const res = await worker.fetch(new Request('https://x/#t=correct-secret'), env, {});
  return res.text();
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
  const buzzes = [];
  const html = await pageHtml();
  const s = driveClientScriptSession(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    localStorage, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance,
    vibrate: (p) => { buzzes.push(p); return true; },
    extraGlobals: { __vite_ssr_import_0__: lib },
  });
  const speaker = s.getElementById('speakToggle');
  const mute = s.getElementById('muteToggle');
  const texts = () => synth.spoken.map((u) => u.text).filter((t) => t !== '');
  return { html, synth, s, buzzes, texts, tapMute: () => mute._listeners.click(), tapSpeaker: () => speaker._listeners.click(), mute, speaker };
}

const goldRow = (id, over = {}) => ({ id, platform: 'tw', user: 'Baller', login: 'baller', kind: 'cheer', amount: '500 bits', text: 'yo', twId: 'g' + id, ts: Date.now(), ...over });
const chatRow = (id, user = 'Alice', text = 'hello there') => ({ id, platform: 'tw', user, login: user.toLowerCase(), text, ts: Date.now() });
const readout = (id, over = {}) => ({ id, platform: 'tw', user: 'Viewer', login: 'viewer', text: 'read this', readAloud: true, twId: 'r' + id, ts: Date.now(), ...over });

describe('PWA mute button markup', () => {
  it('sits immediately left of the speaker button in #controls', async () => {
    const { html } = await setup();
    const controls = html.match(/<div id="controls">([\s\S]*?)<\/div>/)[1];
    const ids = [...controls.matchAll(/<button id="(\w+)"/g)].map((m) => m[1]);
    expect(ids.slice(0, 2)).toEqual(['muteToggle', 'speakToggle']);
  });

  it('shares the compact control style and cannot wrap or grow the topbar row', async () => {
    const { html } = await setup();
    expect(html).toMatch(/#muteToggle[^{]*\{[^}]*pointer-events: auto/);
    expect(html).toMatch(/#controls \{[^}]*flex-wrap: nowrap/);
  });

  it('uses glyphs different from the speaker modes', () => {
    const speakerGlyphs = Object.values(lib.TTS_MODE_ICONS);
    for (const g of Object.values(lib.TTS_MUTE_ICONS)) expect(speakerGlyphs).not.toContain(g);
    expect(lib.TTS_MUTE_ICONS.muted).not.toBe(lib.TTS_MUTE_ICONS.live);
  });

  it('uses its own storage key, never the mode key', () => {
    expect(lib.TTS_MUTE_KEY).toBe('multichat-tts-muted');
    expect(lib.TTS_MUTE_KEY).not.toBe(lib.TTS_MODE_KEY);
  });
});

describe('mute behavior in the real PWA script', () => {
  it('starts unmuted: a gold row speaks', async () => {
    const { s, texts, mute } = await setup();
    expect(mute.title).toBe('TTS mute: off');
    s.fire(goldRow(1));
    expect(texts()).toHaveLength(1);
  });

  it('muted: a gold row buzzes but never speaks, and the floor + spoken set advance', async () => {
    const { s, texts, buzzes, tapMute, synth, s: page } = await setup();
    tapMute();
    s.fire(goldRow(2));
    expect(texts()).toEqual([]);
    expect(synth.spoken).toHaveLength(0);
    expect(buzzes).toEqual([80]);
    const saved = JSON.parse(page.getStored('multichat-spoken'));
    expect(saved.floor).toBe(2);
    expect(saved.ids.map((p) => p[0])).toContain(2);
  });

  it('unmute: the muted row is not replayed, the next gold row speaks', async () => {
    const { s, texts, tapMute } = await setup();
    tapMute();
    s.fire(goldRow(3));
    s.fire(goldRow(4));
    tapMute();
    expect(texts()).toEqual([]);
    s.fire(goldRow(3));
    expect(texts()).toEqual([]);
    s.fire(goldRow(5));
    expect(texts()).toHaveLength(1);
  });

  it('tapping mute mid-utterance cancels the in-flight line and drops the queue', async () => {
    const { s, texts, synth, tapMute, buzzes } = await setup();
    s.fire(goldRow(6));
    s.fire(goldRow(7));
    expect(texts()).toHaveLength(1);
    expect(synth.speaking).toBe(true);
    const cancelsBefore = synth.cancels;
    tapMute();
    expect(synth.cancels).toBeGreaterThan(cancelsBefore);
    expect(synth.speaking).toBe(false);
    expect(texts()).toHaveLength(1);
    expect(buzzes).toEqual([80, 80]);
  });

  it('muted: All-mode chat is silent but the floor advances', async () => {
    const { s, texts, tapMute, s: page } = await setup({ 'multichat-tts-mode': 'all' });
    tapMute();
    s.fire(chatRow(10));
    expect(texts()).toEqual([]);
    expect(JSON.parse(page.getStored('multichat-spoken')).floor).toBe(10);
    tapMute();
    s.fire(chatRow(11));
    expect(texts()).toEqual(['Alice, hello there']);
  });

  it('muted: a Read-Out-Loud row is silent', async () => {
    const { s, texts, tapMute } = await setup();
    tapMute();
    s.fire(readout(12));
    expect(texts()).toEqual([]);
  });

  it('muted: the speaker button still cycles Gold/All and announces nothing', async () => {
    const { texts, tapMute, tapSpeaker, speaker } = await setup();
    tapMute();
    tapSpeaker();
    expect(speaker.title).toBe('TTS: all');
    tapSpeaker();
    expect(speaker.title).toBe('TTS: gold');
    expect(texts()).toEqual([]);
  });

  it('mute does not change the stored speaker mode', async () => {
    const { tapMute, s } = await setup({ 'multichat-tts-mode': 'all' });
    tapMute();
    expect(s.getStored('multichat-tts-mode')).toBe('all');
  });

  it('a muted raid still buzzes', async () => {
    const { s, tapMute, buzzes } = await setup();
    tapMute();
    s.fire({ id: 20, platform: 'tw', sys: 'raid', text: 'raid', ts: Date.now() });
    expect(buzzes).toEqual([[80, 40, 80]]);
  });
});

describe('mute persistence', () => {
  it('round-trips through its own key and survives a reload', async () => {
    const first = await setup();
    first.tapMute();
    expect(first.s.getStored('multichat-tts-muted')).toBe('1');
    const second = await setup({ 'multichat-tts-muted': first.s.getStored('multichat-tts-muted') });
    expect(second.mute.title).toBe('TTS mute: on');
    second.s.fire(goldRow(30));
    expect(second.texts()).toEqual([]);
    second.tapMute();
    expect(second.s.getStored('multichat-tts-muted')).toBe('0');
    second.s.fire(goldRow(31));
    expect(second.texts()).toHaveLength(1);
  });

  it('a stored speaker mode of off still reads as gold and is not muted', async () => {
    const { speaker, mute } = await setup({ 'multichat-tts-mode': 'off' });
    expect(speaker.title).toBe('TTS: gold');
    expect(mute.title).toBe('TTS mute: off');
  });
});

describe('Read-Out-Loud row buzzes like other gold-class rows', () => {
  it('buzzes once, and not again on a repeat id', async () => {
    const { s, buzzes, texts } = await setup();
    s.fire(readout(40));
    expect(buzzes).toEqual([80]);
    expect(texts()).toEqual(['Viewer, read this']);
    s.fire(readout(40));
    expect(buzzes).toEqual([80]);
  });
});
