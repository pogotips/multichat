import { ChatHub } from '../../src/worker.js';

// Map-backed fake ctx.storage — real DO storage semantics close enough for
// tests: get()/put() round-trip, absent key resolves to undefined.
export function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async setAlarm() {},
    async get(key) { return map.has(key) ? map.get(key) : undefined; },
    async put(key, value) { map.set(key, value); },
    _map: map,
  };
}

// Real DurableObjectState always provides blockConcurrencyWhile — ChatHub's
// constructor uses it to hydrate esModerateHealthy from storage before
// serving any request. The constructor itself can't await it (constructors
// aren't async, matching real DO semantics), so tests that care about the
// hydrated value need to await it explicitly — this stashes the in-flight
// promise on the ctx object itself (`ctx.pendingBlockConcurrencyWhile`),
// reachable from a hub as `hub.ctx.pendingBlockConcurrencyWhile` (ChatHub's
// constructor stores `this.ctx = ctx`).
//
// Chained (not just invoked) so concurrent callers actually serialize, same
// as the real primitive: a second blockConcurrencyWhile call queued while
// the first's callback is still running must not start until the first
// resolves. A naive `fn()`-and-return stub would let overlapping callers'
// internal awaits interleave freely — exactly the race handleTtsAllow's
// daily-budget block relies on this call to prevent — so a concurrency test
// against that shape would pass or fail without ever exercising the
// serialization it's meant to prove.
function attachBlockConcurrencyWhile(ctx) {
  let chain = Promise.resolve();
  ctx.blockConcurrencyWhile = (fn) => {
    const p = chain.then(() => fn());
    chain = p.catch(() => {}); // one rejecting callback must not wedge later callers
    ctx.pendingBlockConcurrencyWhile = p;
    return p;
  };
  return ctx;
}

// Minimal DO harness: ChatHub's constructor only stashes ctx/env. Defaults to
// a full Map-backed storage double (get/put round-trip, no initial data) —
// a strict superset of the bare setAlarm-only stub some call sites used to
// build by hand, safe even for tests that never touch storage. Pass
// `storage` explicitly (e.g. makeStorage({...})) to seed initial data; pass
// `capturePut` to observe/react to CAPTURE.put calls.
export function makeHub({ envOverrides = {}, storage, capturePut } = {}) {
  const putCalls = [];
  const env = {
    TWITCH_CHANNEL: 'testchannel',
    CAPTURE: {
      async put(key, body) {
        putCalls.push({ key, body });
        if (capturePut) return capturePut(key, body);
      },
    },
    ...envOverrides,
  };
  const ctx = attachBlockConcurrencyWhile({ storage: storage || makeStorage() });
  const hub = new ChatHub(ctx, env);
  return { hub, putCalls };
}

// Mock Request-like object — handleIngestYt only calls .json() and, for mod
// actions, .headers.get('x-multichat-caller') (mirrors the edge's caller
// header, set from which ingest secret matched). Defaults to 'poller' so
// callers that don't care about caller-scoping don't need to know about it.
export function req(body, { caller = 'poller' } = {}) {
  return {
    json: async () => body,
    headers: { get: (name) => (name.toLowerCase() === 'x-multichat-caller' ? caller : null) },
  };
}

// EventSub (DO-internal handleEventSub route) test env, kept separate from
// makeHub to avoid changing eventsub.test.js's fixture shape.
export function makeDoEnv(overrides = {}) {
  return { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', ...overrides };
}

// storage defaults to a fresh makeStorage() (real get/put round-trip) — the
// constructor's blockConcurrencyWhile hydration reads esModerateHealthy from
// it on every construction now, so this can no longer be a bare `{}`. Pass a
// pre-seeded makeStorage({esModerateHealthy: true}) to test hydration —
// await the returned hub's `hub.ctx.pendingBlockConcurrencyWhile` first.
export function makeEventSubHub(overrides = {}, storage) {
  const ctx = attachBlockConcurrencyWhile({ storage: storage || makeStorage() });
  return new ChatHub(ctx, makeDoEnv(overrides));
}
