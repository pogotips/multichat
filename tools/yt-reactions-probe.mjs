#!/usr/bin/env node
// Standalone reaction-fountain probe — checks whether a given live video's
// get_live_chat responses carry frameworkUpdates.entityBatchUpdate.mutations[]
// .payload.emojiFountainDataEntity, without needing a broadcast of our own or
// running the full poller. No deps beyond Node's built-in fetch (Node >=18).
//
// Usage: node tools/yt-reactions-probe.mjs <videoId> [pollCount]
//
// Deliberately independent of youtube-chat/patches/ — this hits YouTube's
// innertube endpoints directly so it still works if the patched library ever
// changes shape, and so it's runnable standalone against any live channel.

const videoId = process.argv[2];
const pollCount = Number.parseInt(process.argv[3], 10) || 5;
const POLL_INTERVAL_MS = 5_000;

if (!videoId) {
  console.error('usage: node tools/yt-reactions-probe.mjs <videoId> [pollCount]');
  process.exit(1);
}

// Same key/version extraction regexes as youtube-chat's own
// getOptionsFromLivePage (tools/yt-poller/node_modules/youtube-chat/dist/parser.js)
// — kept independent rather than imported so this probe has zero dependency
// on the poller's node_modules being installed.
function extractInnertubeApiKey(html) {
  const m = html.match(/['"]INNERTUBE_API_KEY['"]:\s*['"](.+?)['"]/);
  if (!m) throw new Error('INNERTUBE_API_KEY not found on live_chat page');
  return m[1];
}

function extractClientVersion(html) {
  const m = html.match(/['"]clientVersion['"]:\s*['"]([\d.]+?)['"]/);
  if (!m) throw new Error('clientVersion not found on live_chat page');
  return m[1];
}

// The live_chat page embeds more than one continuation token (e.g. top chat
// vs. live chat replay) — the one this probe wants is the live top-chat
// continuation, which in practice starts with the marker prefix '0ofMyAO'.
// Falls back to the first continuation token found if no match carries that
// marker (surfaced as a warning: page structure may have changed).
function extractLiveChatContinuation(html) {
  const matches = [...html.matchAll(/"continuation":"([^"]+)"/g)].map((m) => m[1]);
  const marked = matches.find((c) => c.includes('0ofMyAO'));
  if (marked) return marked;
  if (matches.length > 0) {
    console.error(`warning: no continuation token contained '0ofMyAO' marker — falling back to the first of ${matches.length} found`);
    return matches[0];
  }
  throw new Error('no continuation token found on live_chat page');
}

// YouTube's live_chat page rejects a UA-less fetch with a bare "It looks
// like you're using an older version of your browser" interstitial (no
// INNERTUBE_API_KEY, no continuation token) — a real desktop Chrome UA is
// required, same as what the youtube-chat lib itself sends on the poller's
// live path.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

async function fetchLiveChatPage(id) {
  const url = `https://www.youtube.com/live_chat?v=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`live_chat page fetch failed: ${res.status}`);
  return res.text();
}

async function getLiveChat({ apiKey, clientVersion, continuation }) {
  const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'en-US,en;q=0.9', 'user-agent': BROWSER_UA },
    body: JSON.stringify({
      context: { client: { clientVersion, clientName: 'WEB' } },
      continuation,
    }),
  });
  if (!res.ok) throw new Error(`get_live_chat fetch failed: ${res.status}`);
  return res.json();
}

// Same shape extraction as tools/yt-poller/patches/youtube-chat+2.2.0.patch's
// frameworkUpdates hook — duplicated here (not imported) so this probe has
// zero dependency on the poller's node_modules/patch state.
function extractReactionEntities(data) {
  const mutations = ((data.frameworkUpdates || {}).entityBatchUpdate || {}).mutations || [];
  return mutations
    .filter((m) => m.payload && m.payload.emojiFountainDataEntity)
    .map((m) => m.payload.emojiFountainDataEntity);
}

function bucketTotals(entity) {
  return (entity.reactionBuckets || []).map((b) => b.totalReactions || 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`fetching live_chat page for videoId=${videoId}`);
  const html = await fetchLiveChatPage(videoId);
  const apiKey = extractInnertubeApiKey(html);
  const clientVersion = extractClientVersion(html);
  let continuation = extractLiveChatContinuation(html);
  console.log(`clientVersion=${clientVersion} continuation=${continuation.slice(0, 24)}...`);

  let firstNonzero = null;
  for (let i = 1; i <= pollCount; i++) {
    const data = await getLiveChat({ apiKey, clientVersion, continuation });
    const entities = extractReactionEntities(data);
    const totals = entities.flatMap(bucketTotals);
    console.log(`poll ${i}/${pollCount}: entities=${entities.length} bucketTotals=[${totals.join(',')}]`);
    if (!firstNonzero && totals.some((t) => t > 0)) {
      firstNonzero = entities.find((e) => bucketTotals(e).some((t) => t > 0));
    }

    const continuationData = data.continuationContents?.liveChatContinuation?.continuations?.[0];
    const next = continuationData?.invalidationContinuationData?.continuation
      || continuationData?.timedContinuationData?.continuation;
    if (!next) {
      console.error('no further continuation token — stream likely ended');
      break;
    }
    continuation = next;

    if (i < pollCount) await sleep(POLL_INTERVAL_MS);
  }

  if (firstNonzero) {
    console.log('first nonzero emojiFountainDataEntity:');
    console.log(JSON.stringify(firstNonzero, null, 2));
  } else {
    console.log('no nonzero reaction entity seen across all polls');
  }
}

main().catch((err) => {
  console.error(`probe failed: ${err.message}`);
  process.exit(1);
});
