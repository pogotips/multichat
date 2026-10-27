// Regression test for a real production incident (2026-09-03): server-side
// logged gif_host_accepted for a real Twitch GIF message, but the PWA
// rendered zero <img class="gif">, no console error, on the LIVE deployed
// Worker. Every other test in this repo imports src/lib.js and src/worker.js
// directly via vitest -- plain, UNMINIFIED source. The bug only existed in
// the actual `wrangler deploy` esbuild bundle: esbuild wrapped
// renderGifToken's old locally-scoped `buildImg` closure in its own
// `__name()` runtime helper (defined only inside the SERVER's bundle), and
// that call got baked into buildImg's Function.prototype.toString() text --
// which is what ${renderGifToken} template-interpolates into the CLIENT
// <script>, where __name is never defined. ReferenceError, silently
// swallowed by socket.onmessage's empty `catch {}`.
//
// This is the ONLY test class that can catch that bug: it drives the
// REAL `wrangler deploy --dry-run` bundle output through a vm sandbox and
// fires a real onmessage event, exactly like a browser would. IS picked up
// by the default `npm test` (vitest globs test/*.test.js, no exclusion
// configured) even though it shells out to wrangler and is noticeably
// slower than the rest of the suite (~1s of a ~2s total run) -- unlike
// test:gate, which needs a separate vitest config/pool and genuinely can't
// run inline. Needs wrangler.jsonc present (gitignored, see CLAUDE.md Setup).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { driveClientScript, driveClientScriptSession, findFirst } from './helpers/vm-page-driver.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { frame: GIF_FRAME } = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'gif-real-frame.json'), 'utf8'),
);
const GIF_URL = GIF_FRAME.gifs[0].url;

let bundlePath;
let bundleDir;

async function extractScript(worker, url, extraEnv = {}) {
  const env = { MULTICHAT_VIEW_SECRET: 'x', MULTICHAT_OVERLAY_SECRET: 'y', ...extraEnv };
  const res = await worker.fetch(new Request(url), env, {});
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`no <script> in response for ${url}`);
  return m[1];
}

beforeAll(() => {
  if (!existsSync(path.join(REPO_ROOT, 'wrangler.jsonc'))) {
    throw new Error(
      'wrangler.jsonc not found — run: cp wrangler.jsonc.example wrangler.jsonc (see INSTALL.md)',
    );
  }
  bundleDir = mkdtempSync(path.join(tmpdir(), 'multichat-bundle-test-'));
  execFileSync('wrangler', ['deploy', '--dry-run', '--outdir', bundleDir, '--config', 'wrangler.jsonc'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  bundlePath = path.join(bundleDir, 'worker.js');
}, 60_000);

afterAll(() => {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

describe('real wrangler-bundle GIF render (production-parity, not plain source)', () => {
  it('PWA: fresh localStorage renders exactly one img.gif with the real reported frame', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/#t=x');
    const feed = driveClientScript(script, GIF_FRAME);
    expect(feed.children).toHaveLength(1);
    const img = findFirst(feed.children[0], (n) => n.tagName === 'img');
    expect(img).not.toBeNull();
    expect(img.className).toBe('gif');
    expect(img.src).toBe(GIF_URL);
  });

  it('overlay: default config (gifAlt absent) renders alt text, not an image', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y');
    const feed = driveClientScript(script, GIF_FRAME);
    expect(feed.children).toHaveLength(1);
    const img = findFirst(feed.children[0], (n) => n.tagName === 'img' && n.className === 'gif');
    expect(img).toBeNull();
    const altSpan = findFirst(feed.children[0], (n) => n.className === 'gif-alt');
    expect(altSpan).not.toBeNull();
  });

  it('overlay: gifAlt=off (scene operator opted in) renders exactly one img.gif', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y&gifAlt=off');
    const feed = driveClientScript(script, GIF_FRAME);
    expect(feed.children).toHaveLength(1);
    const img = findFirst(feed.children[0], (n) => n.tagName === 'img' && n.className === 'gif');
    expect(img).not.toBeNull();
    expect(img.src).toBe(GIF_URL);
  });

  it('all 3 pages: the embedded renderGifToken text carries no bare __name() call', async () => {
    const mod = await import(bundlePath);
    for (const url of ['https://x/#t=x', 'https://x/overlay?t=y', 'https://x/overlay/config?t=y']) {
      const script = await extractScript(mod.default, url);
      const fnMatch = script.match(/function renderGifToken\([\s\S]*?\n}/);
      expect(fnMatch, `renderGifToken not found in script for ${url}`).not.toBeNull();
      expect(fnMatch[0], `${url}: renderGifToken body must not reference __name`).not.toContain('__name');
    }
  });

  it('onmessage catch on a bad frame reports via the beacon (name+message, no frame contents) and keeps processing the next frame', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/#t=x');
    const { feed, fire, sentBeacons } = driveClientScriptSession(script);
    // A frame that throws deep inside addRow (renderText's [...text] spread
    // on null) — deliberately NOT the fixed esbuild bug (that's covered
    // above); this proves the catch-and-report-and-continue contract holds
    // for ANY thrown error, not just this one incident's specific cause.
    fire({ ...GIF_FRAME, id: GIF_FRAME.id + 1, text: null });
    expect(feed.children).toHaveLength(0); // the bad frame never inserted a row
    expect(sentBeacons).toHaveLength(1);
    const reported = JSON.parse(sentBeacons[0].body);
    expect(reported.message).toMatch(/^TypeError:/); // name + message
    expect(JSON.stringify(reported)).not.toContain(GIF_FRAME.text); // never frame contents
    expect(JSON.stringify(reported)).not.toContain(GIF_URL);
    fire(GIF_FRAME); // the next, good frame — must still render
    expect(feed.children).toHaveLength(1);
    const img = findFirst(feed.children[0], (n) => n.tagName === 'img' && n.className === 'gif');
    expect(img).not.toBeNull();
    expect(img.src).toBe(GIF_URL);
  });
});

// Drives the OVERLAY page's real onmessage/mark handlers through the same
// wrangler dry-run bundle + vm sandbox as the GIF suite above — a financial
// frame must render a row AND enqueue a TTS fetch; a 'mark' delete matching
// a QUEUED (not-yet-playing) item must drop it before it ever reaches /tts.
// The vm driver's fetch stub records calls instead of the default silent
// reject, so "never fetched" is observable without exposing the page's
// internal ttsQueue variable.
describe('real wrangler-bundle overlay TTS queue (production-parity)', () => {
  it('a financial frame renders a row and enqueues a /tts fetch', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y');
    const ttsCalls = [];
    const { feed, fire } = driveClientScriptSession(script, {
      fetch: (url, opts) => { ttsCalls.push({ url, body: JSON.parse(opts.body) }); return Promise.reject(new Error('stub')); },
    });
    fire({ id: 1, kind: 'cheer', amount: '500 bits', user: 'baller', text: 'yo', twId: 'msg-1', ts: Date.now() });
    expect(feed.children).toHaveLength(1);
    expect(feed.children[0].className).toContain('paid');
    expect(ttsCalls).toHaveLength(1);
    expect(ttsCalls[0].url).toContain('/tts?t=');
    expect(ttsCalls[0].body.text).toContain('500 bits');
  });

  it('a mark deleting a QUEUED (not-yet-playing) item drops it — it is never fetched from /tts', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y');
    const ttsCalls = [];
    // Every call rejects (never resolves) so the first item stays "in
    // flight" (ttsPlaying=true) while the second sits queued behind it —
    // exactly the window markMatchesQueueItem's queue-side filter covers.
    const { feed, fire, fireEvent } = driveClientScriptSession(script, {
      fetch: (url, opts) => { ttsCalls.push({ url, body: JSON.parse(opts.body) }); return Promise.reject(new Error('stub')); },
    });
    fire({ id: 1, kind: 'cheer', amount: '500 bits', user: 'baller', text: 'first', twId: 'msg-1', ts: Date.now() });
    fire({ id: 2, kind: 'cheer', amount: '100 bits', user: 'other', text: 'second', twId: 'msg-2', ts: Date.now() });
    expect(feed.children).toHaveLength(2); // both rows still render regardless of TTS queue state
    expect(ttsCalls).toHaveLength(1); // only the first item has been dequeued to /tts so far
    const dropped = fireEvent('mark', { action: 'delete', platform: 'tw', targetId: 'msg-2' });
    expect(dropped).toBe(true); // proves the overlay wired a 'mark' listener, not just a no-op
    // Flush the microtask queue so item 1's rejected /tts fetch settles and
    // pumpQueue's finally-block re-drains the queue — item 2 must be gone.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ttsCalls).toHaveLength(1); // item 2 was struck before its turn — never fetched
  });
});

// Every ${helper} interpolated into the 3 served pages, generalized from the
// single renderGifToken check above. Static-text sweep, not per-helper
// execution: extracts each helper's OWN function body (brace-matched, not a
// bounded regex, since some bodies nest braces several levels deep) from the
// real dry-run bundle's actual served script, and asserts it references none
// of esbuild's runtime helpers. This is comprehensive for the exact bug class
// that shipped (any named local closure nested inside an interpolated
// function) regardless of whether that helper is otherwise exercised by a
// render-path test above — see the internal fast-follow list for what a full
// per-helper EXECUTION sweep (actually calling each with valid args, not
// just text-scanning) would still need beyond this.
const ESBUILD_RUNTIME_HELPERS = ['__name', '__publicField', '__decorateClass', '__esm', '__commonJS', '__export', '__toESM', '__require', '__privateGet', '__privateSet', '__privateAdd'];

const PAGE_HELPERS = {
  'https://x/#t=x': ['roleClass', 'emitCategory', 'isEmittable', 'resolveToken', 'cleanSpokenName', 'spokenCurseKey', 'isSpokenCurse', 'bleepSpokenText', 'isCurseName', 'spokenNameFor', 'applySpokenWordMap', 'spokenSenderName', 'cleanSpokenMentions', 'formatUtterance', 'translateRequestText', 'translateLabel', 'markMatchesQueueItem', 'nextTtsMode', 'chatSpeakSkipReason', 'formatChatUtterance', 'readoutUtterance', 'enqueueSpeechItem', 'parseTtsCommand', 'applyTtsCommand', 'formatCount', 'pullPhase', 'versionMismatch', 'createPullGate', 'isClientStale', 'supersedeSocket', 'shouldSendClientError', 'isAllowedEmojiUrl', 'isAllowedGifUrl', 'renderGifToken', 'mergeAnnotations', 'appendWithMention', 'renderText', 'buildRow', 'reconnectBackoffMs', 'shouldForceYtReconnect', 'createSeenIdGate', 'detectReplayGap', 'userKeyOf', 'createMessageStore', 'parseAmountNumber', 'splitAmountCurrency', 'summarizeGold', 'sheetStats', 'copyHandle', 'writeClipboard', 'stripEmoteRanges', 'stripControlChars', 'stripUrls', 'isTtsBotName', 'translateRetryable', 'readFeedCursor', 'createFeedCursor'],
  'https://x/overlay?t=y': ['roleClass', 'isAllowedEmojiUrl', 'isAllowedGifUrl', 'renderGifToken', 'mergeAnnotations', 'appendWithMention', 'renderText', 'buildRow', 'reactionSpawnUnits', 'spawnReactionParticle', 'cleanSpokenName', 'spokenCurseKey', 'isCurseName', 'spokenNameFor', 'applySpokenWordMap', 'spokenSenderName', 'cleanSpokenMentions', 'stripControlChars', 'stripUrls', 'collapseRepeatedChars', 'sanitizeSpokenBody', 'formatUtterance', 'formatOverlayUtterance', 'formatOverlayChatUtterance', 'enqueueCapped', 'supersedeSocket', 'markMatchesQueueItem', 'shouldSendClientError', 'reconnectBackoffMs', 'shouldForceYtReconnect'],
  'https://x/overlay/config?t=y': ['roleClass', 'isAllowedEmojiUrl', 'isAllowedGifUrl', 'renderGifToken', 'mergeAnnotations', 'appendWithMention', 'renderText', 'buildRow'],
};

// PWA-only helpers: the reload feed cursor (readFeedCursor/createFeedCursor,
// 'multichat-feed', the ring-replay sentinel) is interpolated at the PWA
// embed site only. OBS owns the overlay's lifecycle — a scene-switch reload
// must keep getting zero ring rows (ARCHITECTURE "Replay tagging"), so the
// overlay and overlay-config scripts must not even carry the helper text.
const PWA_ONLY_HELPERS = ['readFeedCursor', 'createFeedCursor'];
const PWA_ONLY_TOKENS = ['multichat-feed', 'RING_REPLAY_EVENT_ID', 'FEED_CURSOR_KEY'];
describe('reload feed cursor is PWA-only: neither overlay page carries it', () => {
  it.each(['https://x/overlay?t=y', 'https://x/overlay/config?t=y'])('%s', async (url) => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, url);
    for (const name of PWA_ONLY_HELPERS) {
      expect(script, `${url} carries ${name}`).not.toMatch(new RegExp(`function\\s+${name}\\s*\\(`));
    }
    for (const token of PWA_ONLY_TOKENS) {
      expect(script, `${url} carries ${token}`).not.toContain(token);
    }
  });
  it('the PWA page carries every one of them (so the assertion above is testing presence vs absence, not a typo)', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/#t=x');
    for (const name of PWA_ONLY_HELPERS) expect(script).toMatch(new RegExp(`function\\s+${name}\\s*\\(`));
    for (const token of PWA_ONLY_TOKENS) expect(script).toContain(token);
  });
});

// YT-chip forced reconnect (feature/yt-chip-reconnect): the helper is
// interpolated at the PWA and overlay embed sites only -- overlay-config is a
// static preview page with no live SSE stream to reconnect.
describe('shouldForceYtReconnect is not embedded in overlay-config (minified bundle)', () => {
  it('overlay-config carries neither the helper nor its tokens; the PWA and overlay do', async () => {
    const mod = await import(bundlePath);
    const cfg = await extractScript(mod.default, 'https://x/overlay/config?t=y');
    expect(cfg).not.toMatch(/function\s+shouldForceYtReconnect\s*\(/);
    expect(cfg).not.toContain('yt_stale');
    for (const url of ['https://x/#t=x', 'https://x/overlay?t=y']) {
      const script = await extractScript(mod.default, url);
      expect(script, url).toMatch(/function\s+shouldForceYtReconnect\s*\(/);
      expect(script, url).toContain('yt_stale');
    }
  });
});

// Brace-counts from the "function <name>(" (or "function <name> (") token to
// its matching close — a bounded regex can't reliably do this once a body
// nests several levels of braces (e.g. isEmittable's object literal args).
function extractFunctionBody(script, name) {
  const startMatch = script.match(new RegExp(`function\\s+${name}\\s*\\(`));
  if (!startMatch) return null;
  const openParenIdx = startMatch.index + startMatch[0].length - 1;
  let depth = 0;
  let i = openParenIdx;
  for (; i < script.length; i++) {
    if (script[i] === '{') { depth++; if (depth === 1) break; }
  }
  const bodyStart = i;
  depth = 0;
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return script.slice(startMatch.index, i);
}

describe('all interpolated ${helper} functions across the 3 pages: no esbuild runtime helper leaks into their own body text', () => {
  it.each(Object.entries(PAGE_HELPERS).flatMap(([url, helpers]) => helpers.map((name) => [url, name])))(
    '%s :: %s',
    async (url, name) => {
      const mod = await import(bundlePath);
      const script = await extractScript(mod.default, url);
      const body = extractFunctionBody(script, name);
      expect(body, `${name} not found (as a function declaration) in script for ${url}`).not.toBeNull();
      for (const helper of ESBUILD_RUNTIME_HELPERS) {
        expect(body, `${url} :: ${name} body references esbuild runtime helper "${helper}"`).not.toContain(helper + '(');
      }
    },
  );
});

// M2 (ChatHub review of 2026-09-12, internal): the sweep above only checks a
// helper's OWN body text for esbuild leaks — it never checks whether an
// identifier that body actually REFERENCES was itself interpolated onto the
// same page. That's the exact root-cause class behind H1: formatOverlayUtterance
// calls sanitizeSpokenBody, but nothing required sanitizeSpokenBody to ship
// alongside it on the overlay page, so a ReferenceError was possible with
// zero red flags from the sweep above. This extracts every exported
// function/const name from BOTH src/lib.js and src/worker.js — a page
// helper can be a worker.js-local export just as easily as a lib.js one
// (shouldSendClientError/reconnectBackoffMs/createSeenIdGate/etc. are all
// `export function` in worker.js, not lib.js, and were previously invisible
// to this scan entirely — covered only by hand-listing them in PAGE_HELPERS)
// — scans each interpolated helper's body for free identifiers matching one,
// and asserts that export is separately declared somewhere else in the SAME
// page's script (as `function NAME(` or `const NAME =`) — i.e. it was
// actually interpolated, not just called.
const LIB_SOURCE = readFileSync(path.join(REPO_ROOT, 'src', 'lib.js'), 'utf8');
const WORKER_SOURCE = readFileSync(path.join(REPO_ROOT, 'src', 'worker.js'), 'utf8');
const EXPORT_NAME_RE = /^export (?:function|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const HELPER_EXPORT_NAMES = [
  ...new Set([
    ...[...LIB_SOURCE.matchAll(EXPORT_NAME_RE)].map((m) => m[1]),
    ...[...WORKER_SOURCE.matchAll(EXPORT_NAME_RE)].map((m) => m[1]),
  ]),
];

describe('transitive check: an interpolated helper must not reference a lib.js/worker.js export that is not also interpolated on that page', () => {
  it.each(Object.entries(PAGE_HELPERS).flatMap(([url, helpers]) => helpers.map((name) => [url, name])))(
    '%s :: %s',
    async (url, name) => {
      const mod = await import(bundlePath);
      const script = await extractScript(mod.default, url);
      const body = extractFunctionBody(script, name);
      expect(body, `${name} not found (as a function declaration) in script for ${url}`).not.toBeNull();
      const referenced = new Set(
        [...body.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)]
          .map((m) => m[1])
          .filter((ident) => ident !== name && HELPER_EXPORT_NAMES.includes(ident)),
      );
      for (const ident of referenced) {
        const declaredOnPage = new RegExp(`function\\s+${ident}\\s*\\(|const\\s+${ident}\\s*=`).test(script);
        expect(declaredOnPage, `${url} :: ${name} references "${ident}" which is never interpolated into this page's script`).toBe(true);
      }
    },
  );
});

// Spoken @mentions + word map (MULTICHAT_TTS_SAY_AS) through the REAL
// minified bundle: overlay and PWA both speak the mapped/cleaned text. The
// overlay now references cleanSpokenName/the curse-name check/the word map
// transitively (spokenNameFor, spokenSenderName, cleanSpokenMentions,
// applySpokenWordMap) -- a missing interpolation would be a ReferenceError
// swallowed by onmessage, i.e. silent speech, so prove they are present and
// that the page actually speaks.
const SAY_AS_ENV = { MULTICHAT_TTS_SAY_AS: JSON.stringify({ Word: 'wurd' }) };
const SAY_AS_SPEECH_HELPERS = ['cleanSpokenName', 'spokenCurseKey', 'isCurseName', 'spokenNameFor', 'applySpokenWordMap', 'spokenSenderName', 'cleanSpokenMentions', 'formatOverlayChatUtterance'];

describe('spoken-name helpers are interpolated on the pages that speak (minified bundle)', () => {
  it.each(['https://x/#t=x', 'https://x/overlay?t=y'])('%s carries every speech helper as a function declaration', async (url) => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, url, SAY_AS_ENV);
    const names = url.includes('overlay') ? SAY_AS_SPEECH_HELPERS : SAY_AS_SPEECH_HELPERS.filter((n) => n !== 'formatOverlayChatUtterance');
    for (const name of names) {
      expect(script, `${url} :: ${name}`).toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
    }
    expect(script).toContain('const TTS_SAY_AS = {"Word":"wurd"}');
  });

  it('overlay no longer carries the old @-strip-only mention helper', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y', SAY_AS_ENV);
    expect(script).not.toMatch(/function\s+normalizeSpokenMentions\s*\(/);
  });
});

describe('real wrangler-bundle spoken text (production-parity)', () => {
  const HANDLES = ['Some_Name-x9k', 'Name_42', 'darc-ttv', 'ab12345', 'Word_2'];

  async function overlaySpeech(rows, env = SAY_AS_ENV) {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y&tts=all', env);
    const ttsCalls = [];
    // First /tts call stays pending so each fired row is dequeued in order.
    const { fire } = driveClientScriptSession(script, {
      fetch: (url, opts) => { ttsCalls.push(JSON.parse(opts.body).text); return Promise.reject(new Error('stub')); },
    });
    const out = [];
    for (const r of rows) {
      ttsCalls.length = 0;
      fire({ ts: Date.now(), platform: 'tw', ...r });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      out.push(ttsCalls[0]);
    }
    return out;
  }

  it('overlay plain chat: sender, @mention and word map are spoken the PWA way', async () => {
    const { cleanSpokenName, applySpokenWordMap } = await import('../src/lib.js');
    const map = { Word: 'wurd' };
    const rows = HANDLES.flatMap((h, i) => [
      { id: 100 + i * 2, user: 'Viewer', login: 'viewer', text: 'hey @' + h + ', ok' },
      { id: 101 + i * 2, user: h, login: h.toLowerCase(), text: 'hi' },
    ]);
    rows.push({ id: 200, user: 'Word', login: 'word', text: 'love Word! and @Word_2' });
    const spoken = await overlaySpeech(rows);
    HANDLES.forEach((h, i) => {
      const n = applySpokenWordMap(cleanSpokenName(h), map);
      expect(spoken[i * 2]).toBe('Viewer says hey ' + n + ', ok');
      expect(spoken[i * 2 + 1]).toBe(n + ' says hi');
    });
    expect(spoken[rows.length - 1]).toBe('wurd says love wurd! and wurd');
  });

  it('overlay financial body gets the same mention + word-map treatment (ttsBody=on)', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y&ttsBody=on', SAY_AS_ENV);
    const ttsCalls = [];
    const { fire } = driveClientScriptSession(script, {
      fetch: (url, opts) => { ttsCalls.push(JSON.parse(opts.body).text); return Promise.reject(new Error('stub')); },
    });
    fire({ id: 1, platform: 'tw', kind: 'cheer', amount: '5 bits', user: 'Word', login: 'word', text: 'thanks @Word_2 and Word', ts: Date.now() });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(ttsCalls[0]).toBe('wurd, cheer, 5 bits, thanks wurd and wurd');
  });

  it('overlay: curse-name sender is "someone" and display is untouched', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/overlay?t=y&tts=all', SAY_AS_ENV);
    const ttsCalls = [];
    const { feed, fire } = driveClientScriptSession(script, {
      fetch: (url, opts) => { ttsCalls.push(JSON.parse(opts.body).text); return Promise.reject(new Error('stub')); },
    });
    fire({ id: 1, platform: 'tw', user: 'FuckFace', login: 'fuckface', text: 'hi @Word_2', ts: Date.now() });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(ttsCalls[0]).toBe('someone says hi wurd');
    // display text is the raw typed text, never the spoken form
    expect(JSON.stringify(feed.children[0])).toContain('hi @Word_2');
    expect(JSON.stringify(feed.children[0])).toContain('FuckFace');
  });

  it('PWA All mode: chat line speaks sender, @mention and word map; display untouched', async () => {
    const mod = await import(bundlePath);
    const script = await extractScript(mod.default, 'https://x/#t=x', SAY_AS_ENV);
    const spoken = [];
    const synth = { speak(u) { spoken.push(u.text); }, cancel() {}, pause() {}, resume() {}, speaking: false };
    class FakeUtterance { constructor(text) { this.text = text; } }
    const { feed, fire } = driveClientScriptSession(script, {
      localStorage: { 'multichat-tts-mode': 'all' },
      speechSynthesis: synth,
      SpeechSynthesisUtterance: FakeUtterance,
    });
    fire({ id: 1, platform: 'tw', user: 'Word', login: 'word', text: 'hey @Some_Name-x9k, Word! @Name_42!', ts: Date.now() });
    const said = spoken.filter((t) => t !== '');
    const { cleanSpokenName } = await import('../src/lib.js');
    expect(said).toEqual(['wurd, hey ' + cleanSpokenName('Some_Name-x9k') + ', wurd! ' + cleanSpokenName('Name_42') + '!']);
    expect(JSON.stringify(feed.children[0])).toContain('hey @Some_Name-x9k, Word! @Name_42!');
  });
});
