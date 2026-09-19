// Golden-fixture parity for the src/lib.js buildRow extraction (B2, revised
// from an unrunnable "import main's addRow directly" plan — addRow lives
// inside worker.js's pageHtml template literal, not a real export, so there
// is nothing to import). test/fixtures/buildrow-golden.json was generated
// ONCE by a throwaway script (not committed) that mechanically extracted
// origin/main's pre-extraction render block via `git show HEAD:./src/worker.js`
// and ran it in a vm sandbox against the same fake DOM used here — see the
// fixture's own `_provenance` block for the generating commit SHA. This test
// proves buildRow reproduces that output exactly, so it keeps guarding after
// main moves on even though the generator script itself isn't kept.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildRow, validateOverlayConfig } from '../src/lib.js';
import { roleClass } from '../src/worker.js';
import { createFakeDocument, serializeNode } from './helpers/fake-doc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'buildrow-golden.json'), 'utf8'));

const CASES = Object.keys(golden).filter((k) => k !== '_provenance');

describe('buildRow: parity with main\'s pre-extraction addRow (golden fixture)', () => {
  it.each(CASES)('%s', (name) => {
    const { input, myName, output } = golden[name];
    const doc = createFakeDocument();
    const row = buildRow(input, { myName, roleClass, doc, mention: true });
    expect(serializeNode(row)).toEqual(output);
  });
});

describe('buildRow: purity contract', () => {
  // The extraction's condition-4 requirement: no closure over feed/MAX_ROWS/
  // paused/unseenCount, no calls to updatePill/fireEmission. Those can't be
  // referenced accidentally without a ReferenceError under plain Node (this
  // suite's environment has none of them as globals) -- if this test suite
  // is green at all, that half of the contract already held. This test
  // covers the other half: no silent fallback to a global `document`.
  it('throws rather than silently using a global document when opts.doc is omitted', () => {
    const msg = { platform: 'twitch', user: 'x', text: 'y' };
    expect(() => buildRow(msg, { myName: '', roleClass, mention: true })).toThrow();
  });

  // buildRow is never actually INVOKED by worker.js's own server-side code --
  // it's shipped to the browser via Function.prototype.toString()
  // interpolation (${buildRow} in pageHtml, same mechanism as roleClass/
  // emitCategory above it), so the only real call worker.js's own module
  // execution ever makes to it is `.toString()`, never `()`. workerd has no
  // `document` at all, so a stray real invocation there would be a runtime
  // 500 rather than a build-time error -- this asserts that failure mode is
  // loud (a thrown error a caller must handle) rather than a silent no-op.
  it('opts.mention:false suppresses highlighting without a branch inside buildRow (overlay case)', () => {
    const msg = { platform: 'twitch', user: 'friend', text: 'hey streamer check this out' };
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: 'streamer', roleClass, doc, mention: false });
    const serialized = serializeNode(row);
    const textSpan = serialized.children[2];
    expect(textSpan.children).toEqual([{ text: 'hey streamer check this out' }]);
  });
});

describe('buildRow: gif rendering (msg.gifs)', () => {
  it('renders a gif url via DOM property assignment — a url containing quotes/markup never breaks out of the attribute', () => {
    const evilUrl = 'https://media.giphy.com/g".gif"><script>alert(1)</script>';
    const msg = { platform: 'tw', user: 'x', text: '[gif]', gifs: [{ start: 0, end: 4, id: 'abc', url: evilUrl }] };
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true });
    const serialized = serializeNode(row);
    const textSpan = serialized.children[2];
    expect(textSpan.children).toEqual([{ tag: 'img', className: 'gif', src: evilUrl, alt: '[gif]', loading: 'lazy' }]);
    // serializeNode (fake-doc.js) doesn't carry `decoding` through — check the
    // raw (unserialized) node directly. Spec requires both attributes, eager
    // render is never a reason to drop either.
    const rawImg = row.children[2].children[0];
    expect(rawImg.loading).toBe('lazy');
    expect(rawImg.decoding).toBe('async');
  });

  it('renders the bracketed alt text as plain gray text when the url is absent (server-rejected host)', () => {
    const msg = { platform: 'tw', user: 'x', text: '[gif]', gifs: [{ start: 0, end: 4, id: 'abc' }] };
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true });
    const serialized = serializeNode(row);
    const textSpan = serialized.children[2];
    expect(textSpan.children).toEqual([{ tag: 'span', className: 'gif-alt', children: [{ text: '[gif]' }] }]);
  });

  it('gifsEnabled:false renders a tappable [GIF] chip instead of an eager img', () => {
    const msg = { platform: 'tw', user: 'x', text: '[gif]', gifs: [{ start: 0, end: 4, id: 'abc', url: 'https://media.giphy.com/g.gif' }] };
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true, gifsEnabled: false });
    const serialized = serializeNode(row);
    const textSpan = serialized.children[2];
    expect(textSpan.children).toEqual([{ tag: 'span', className: 'gif-chip', children: [{ text: '[GIF]' }] }]);
  });

  it('gifsEnabled defaults to on (undefined behaves the same as true)', () => {
    const msg = { platform: 'tw', user: 'x', text: '[gif]', gifs: [{ start: 0, end: 4, id: 'abc', url: 'https://media.giphy.com/g.gif' }] };
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true });
    const serialized = serializeNode(row);
    const textSpan = serialized.children[2];
    expect(textSpan.children[0].tag).toBe('img');
  });

  // Overlay's gifAlt config flag (OVERLAY_PARAM_SPEC in lib.js, default ON).
  describe('gifsAsAlt (overlay gifAlt config flag)', () => {
    it('true forces the bracketed alt text even with a valid url and gifsEnabled true', () => {
      const msg = { platform: 'tw', user: 'x', text: '[gif]', gifs: [{ start: 0, end: 4, id: 'abc', url: 'https://media.giphy.com/g.gif' }] };
      const doc = createFakeDocument();
      const row = buildRow(msg, { myName: '', roleClass, doc, mention: true, gifsEnabled: true, gifsAsAlt: true });
      const serialized = serializeNode(row);
      const textSpan = serialized.children[2];
      expect(textSpan.children).toEqual([{ tag: 'span', className: 'gif-alt', children: [{ text: '[gif]' }] }]);
    });

    // buildRow's OWN plumbing: gifsAsAlt undefined/false renders the image —
    // buildRow itself has no notion of "the overlay's default", it just does
    // what it's told. The overlay's actual default (alt text) lives entirely
    // in OVERLAY_PARAM_SPEC.gifAlt.default, proven by the end-to-end test
    // below via the same validateOverlayConfig -> CONFIG.gifAlt -> gifsAsAlt
    // chain worker.js's overlayHtml/overlayConfigHtml scripts actually run.
    it('false/undefined (buildRow-level) renders the image — a caller opts into alt-only, not out of image', () => {
      const msg = { platform: 'tw', user: 'x', text: '[gif]', gifs: [{ start: 0, end: 4, id: 'abc', url: 'https://media.giphy.com/g.gif' }] };
      const doc = createFakeDocument();
      const row = buildRow(msg, { myName: '', roleClass, doc, mention: true, gifsAsAlt: false });
      const rowNoFlag = buildRow(msg, { myName: '', roleClass, doc: createFakeDocument(), mention: true });
      expect(serializeNode(row).children[2].children[0].tag).toBe('img');
      expect(serializeNode(rowNoFlag).children[2].children[0].tag).toBe('img');
    });

    it('end-to-end: overlay gifsAsAlt defaults to true when the gifAlt URL param is absent', () => {
      const { config } = validateOverlayConfig(new URLSearchParams()); // no gifAlt param at all
      expect(config.gifAlt).toBe('on'); // OVERLAY_PARAM_SPEC default, absence-not-rejection
      const gifsAsAlt = config.gifAlt === 'on'; // exact expression worker.js's overlay scripts use
      expect(gifsAsAlt).toBe(true);
      const msg = { platform: 'tw', user: 'x', text: '[gif]', gifs: [{ start: 0, end: 4, id: 'abc', url: 'https://media.giphy.com/g.gif' }] };
      const doc = createFakeDocument();
      const row = buildRow(msg, { myName: '', roleClass, doc, mention: true, gifsAsAlt });
      const serialized = serializeNode(row);
      expect(serialized.children[2].children).toEqual([{ tag: 'span', className: 'gif-alt', children: [{ text: '[gif]' }] }]);
    });
  });
});

// Rewardgift (generic channel-points reward notice, see parseUsernotice's
// rewardgift branch in worker.js) is NOT emote gigantify — corrected
// 2026-09-15. It's its own plain gray kind: no `kind` field (never earns
// gold/ledger/buzz/TTS — those all key off msg.kind alone), no singular
// msg.emote (never the enlarged 3.0-scale image), just an ordinary
// standard-size inline emote via the plural msg.emotes array like any other
// chat row.
describe('buildRow: rewardgift (plain gray, standard-size)', () => {
  const msg = { platform: 'tw', user: 'Giver', text: 'Kappa', rewardGift: true, emotes: [{ id: '25', start: 0, end: 4 }] };

  it('renders the reward-gift class, not paid, not points-gigantify, with a standard-size inline emote (no 3.0-scale image)', () => {
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true });
    expect(row.className).toBe('msg reward-gift');
    const serialized = serializeNode(row);
    expect(serialized.children.some((c) => c.className === 'emote gigantify')).toBe(false);
    expect(serialized.children.some((c) => c.className === 'amount')).toBe(false);
    expect(serialized.children[1]).toMatchObject({ tag: 'span', className: 'user' });
  });
});

// The REAL points-funded gigantify — driven by ChatHub.markPointsGigantify
// correlating channel.channel_points_automatic_reward_redemption.add
// (reward_type gigantify_an_emote) against the matching PRIVMSG (see
// eventsub.test.js for the correlation itself). Same rendering contract as
// PR #64 originally claimed for rewardgift, now correctly wired: no `kind`,
// gray, gold-row-sized via the same singular msg.emote/3.0-scale path
// channel.bits.use's gold row uses.
describe('buildRow: points-funded gigantify (gray, gold-sized)', () => {
  const msg = { platform: 'tw', user: 'Giver', text: 'Kappa', pointsGigantify: true, emote: { id: '25', name: '' } };

  it('renders the points-gigantify class, not paid, with the same 3.0-scale emote image as the gold row', () => {
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true });
    expect(row.className).toBe('msg points-gigantify');
    const serialized = serializeNode(row);
    expect(serialized.children.at(-1)).toEqual({
      tag: 'img',
      className: 'emote gigantify',
      src: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0',
      alt: '25',
      loading: 'lazy',
    });
  });

  it('carries no amount span and no gold (paid) username color', () => {
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true });
    const serialized = serializeNode(row);
    expect(serialized.children.some((c) => c.className === 'amount')).toBe(false);
    expect(serialized.children[1]).toMatchObject({ tag: 'span', className: 'user' });
  });
});

describe('buildRow: bits-funded gigantify stays gold (regression)', () => {
  it('kind:power_up + emote still renders paid/gold, never points-gigantify', () => {
    const msg = { platform: 'tw', user: 'Baller', text: 'Gigantify an Emote', kind: 'power_up', amount: '500 bits', emote: { id: '25', name: 'Kappa' } };
    const doc = createFakeDocument();
    const row = buildRow(msg, { myName: '', roleClass, doc, mention: true });
    expect(row.className).toBe('msg paid');
    const serialized = serializeNode(row);
    expect(serialized.children[1]).toMatchObject({ tag: 'span', className: 'user paid' });
    expect(serialized.children.some((c) => c.className === 'amount')).toBe(true);
  });
});
