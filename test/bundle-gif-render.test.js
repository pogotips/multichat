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
      'wrangler.jsonc not found (gitignored) — copy it in from any existing checkout before running this test. See CLAUDE.md Setup.',
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

// Every ${helper} interpolated into the 3 served pages, generalized from the
// single renderGifToken check above. Static-text sweep, not per-helper
// execution: extracts each helper's OWN function body (brace-matched, not a
// bounded regex, since some bodies nest braces several levels deep) from the
// real dry-run bundle's actual served script, and asserts it references none
// of esbuild's runtime helpers. This is comprehensive for the exact bug class
// that shipped (any named local closure nested inside an interpolated
// function) regardless of whether that helper is otherwise exercised by a
// render-path test above — see FASTFOLLOW_BATCH.md for what a full
// per-helper EXECUTION sweep (actually calling each with valid args, not
// just text-scanning) would still need beyond this.
const ESBUILD_RUNTIME_HELPERS = ['__name', '__publicField', '__decorateClass', '__esm', '__commonJS', '__export', '__toESM', '__require', '__privateGet', '__privateSet', '__privateAdd'];

const PAGE_HELPERS = {
  'https://x/#t=x': ['roleClass', 'emitCategory', 'isEmittable', 'resolveToken', 'cleanSpokenName', 'formatUtterance', 'enqueueCapped', 'formatCount', 'pullPhase', 'versionMismatch', 'createPullGate', 'isClientStale', 'supersedeSocket', 'shouldSendClientError', 'isAllowedEmojiUrl', 'isAllowedGifUrl', 'renderGifToken', 'mergeAnnotations', 'appendWithMention', 'renderText', 'buildRow'],
  'https://x/overlay?t=y': ['roleClass', 'isAllowedEmojiUrl', 'isAllowedGifUrl', 'renderGifToken', 'mergeAnnotations', 'appendWithMention', 'renderText', 'buildRow', 'cleanSpokenName', 'normalizeSpokenMentions', 'formatUtterance', 'formatOverlayUtterance', 'enqueueCapped', 'supersedeSocket', 'markMatchesQueueItem'],
  'https://x/overlay/config?t=y': ['roleClass', 'isAllowedEmojiUrl', 'isAllowedGifUrl', 'renderGifToken', 'mergeAnnotations', 'appendWithMention', 'renderText', 'buildRow'],
};

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
