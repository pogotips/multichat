// SAPISIDHASH — Google's cookie-based request-signing scheme for
// authenticated requests that don't go through a full OAuth flow. YouTube's
// own web client uses it to sign XHR/fetch calls carrying only first-party
// session cookies (no bearer token). There is no official public spec for
// it; the shape below is the one independently reverse-engineered and
// documented by numerous open-source YouTube tools (yt-dlp, chat-downloader,
// assorted Node scrapers) and matches the exact formula given in this
// script's own task spec:
//
//   Authorization: SAPISIDHASH <ts>_<hash>
//   hash = SHA1("<ts> <SAPISID cookie value> <origin>")
//   ts   = current Unix time, seconds
//   origin = "https://www.youtube.com" (must also be sent as the request's
//            own Origin header — the server checks the hash against it)
//
// Verified by hand before wiring this into request headers: for
// ts=1700000000, sapisid="abcdef1234567890", origin="https://www.youtube.com",
// `printf '%s' "1700000000 abcdef1234567890 https://www.youtube.com" | shasum -a 1`
// independently (outside this implementation) produced
// 0129a7f32d4b52d4285af89b0288ba21792abcb0 — see
// test/authed-sapisidhash.test.mjs for the same vector asserted against
// computeSapisidHash.
import crypto from 'node:crypto';

export const SAPISIDHASH_ORIGIN = 'https://www.youtube.com';

export function computeSapisidHash(timestampSec, sapisid, origin = SAPISIDHASH_ORIGIN) {
  const input = `${timestampSec} ${sapisid} ${origin}`;
  return crypto.createHash('sha1').update(input, 'utf8').digest('hex');
}

// `now` is injectable so tests can pin the timestamp instead of racing the
// clock; defaults to the real current time for actual requests.
export function buildSapisidHashHeader(sapisid, { origin = SAPISIDHASH_ORIGIN, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const timestampSec = now();
  const hash = computeSapisidHash(timestampSec, sapisid, origin);
  return `SAPISIDHASH ${timestampSec}_${hash}`;
}

// --- Cookie file parsing -------------------------------------------------
// Accepts either:
//  (a) Netscape/Mozilla cookie-jar format — 7 tab-separated fields per line
//      (domain, flag, path, secure, expiry, name, value); what `curl -c`
//      and most browser cookie-export extensions produce, or
//  (b) JSON — either a flat { name: value } object, or an array of
//      { name, value, ... } objects (the shape some browser extensions,
//      e.g. "Cookie-Editor" or "EditThisCookie", export).
// Format is auto-detected: valid JSON wins, otherwise treated as Netscape.
// Never logs or echoes any cookie value it parses.
export function parseCookieFile(content) {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const map = {};
      for (const entry of parsed) {
        if (entry && typeof entry.name === 'string' && 'value' in entry) map[entry.name] = String(entry.value);
      }
      return map;
    }
    if (parsed && typeof parsed === 'object') {
      return { ...parsed };
    }
  } catch {
    // not JSON — fall through to Netscape format
  }
  const cookies = {};
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const [, , , , , name, value] = fields;
    if (name) cookies[name] = value ?? '';
  }
  return cookies;
}

// SAPISID and __Secure-3PAPISID carry the identical secret value — Google
// mirrors it so contexts that drop plain SAPISID under stricter
// Secure/SameSite cookie handling (some browser cookie-export tools only
// keep __Secure- prefixed cookies) still have a usable copy. Prefer plain
// SAPISID (the name the scheme is documented against); fall back
// transparently to __Secure-3PAPISID.
export function extractSapisid(cookieMap) {
  if (cookieMap?.SAPISID) return cookieMap.SAPISID;
  if (cookieMap?.['__Secure-3PAPISID']) return cookieMap['__Secure-3PAPISID'];
  return null;
}

export function serializeCookieHeader(cookieMap) {
  return Object.entries(cookieMap || {})
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
