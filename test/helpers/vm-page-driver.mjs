// Drives an extracted client <script> (from a real GET / / /overlay /
// /overlay/config response) inside a node:vm sandbox with a minimal fake
// browser, then fires one synthetic SSE message through the REAL captured
// onmessage handler -- exercising addRow/buildRow/renderText/renderGifToken
// exactly as the browser would, not by calling buildRow directly.
//
// Exists specifically because plain vitest imports of src/lib.js and
// src/worker.js run UNMINIFIED source -- they cannot catch a bug that only
// exists in the actual `wrangler deploy` esbuild bundle (see
// test/bundle-gif-render.test.js's own header for the incident this caught).
import vm from 'node:vm';

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); }
}
class FakeTextNode {
  constructor(text) { this.nodeType = 'text'; this.text = text; this.textContent = text; }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.nodeType = 'element';
    this._className = '';
    this.classList = new FakeClassList();
    // setProperty/getPropertyValue for CSS custom properties (e.g. the
    // reaction-burst particle's --drift) — real CSSStyleDeclaration objects
    // don't support plain dot/bracket assignment for `--`-prefixed
    // properties, only these two methods, so a fake style object standing in
    // for one needs to support the same real API real code will call.
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; } };
    this.dataset = {};
    this.children = [];
    this.scrollTop = 0;
    this.tabIndex = 0;
  }
  set className(v) { this._className = v; }
  get className() { return this._className; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get childElementCount() { return this.children.length; }
  set textContent(v) { this.children = [new FakeTextNode(v)]; }
  get textContent() { return this.children.map((c) => c.text ?? c.textContent ?? '').join(''); }
  append(...items) { for (const it of items) this.children.push(typeof it === 'string' ? new FakeTextNode(it) : it); }
  appendChild(el) { this.children.push(el); return el; }
  insertBefore(el, ref) {
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) this.children.unshift(el); else this.children.splice(idx, 0, el);
    return el;
  }
  removeChild(el) { this.children = this.children.filter((c) => c !== el); return el; }
  addEventListener(type, handler) { (this._listeners ??= {})[type] = handler; }
  click() { this._listeners?.click?.(); }
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; } // mark path: no row matching in the fake DOM, but must not throw
  get offsetHeight() { return 0; }
}

class FakeEventSource {
  constructor(url) {
    this._onmessage = null; this._onerror = null; this._onopen = null; this._listeners = {}; this.url = url;
    FakeEventSource.lastInstance = this;
    FakeEventSource.instances.push(this);
  }
  set onmessage(fn) { this._onmessage = fn; }
  get onmessage() { return this._onmessage; }
  // Kept (not discarded) so a test can drive the real onerror → reconnect
  // path; fireError()/fireOpen() on the session object dispatch them.
  set onerror(fn) { this._onerror = fn; }
  get onerror() { return this._onerror; }
  set onopen(fn) { this._onopen = fn; }
  get onopen() { return this._onopen; }
  // Keyed by type (not an array) — every real addEventListener call site in
  // this codebase attaches exactly one handler per event type on a given
  // socket, same simplifying assumption FakeElement's own listener map makes.
  addEventListener(type, handler) { this._listeners[type] = handler; }
  removeEventListener(type) { delete this._listeners[type]; }
  close() {}
}

// Runs `scriptSrc` (one page's extracted <script> body) in a fresh sandbox
// and returns { feed, fire, sentBeacons } — fire(frame) dispatches one more
// SSE message through the real captured onmessage handler (call it more than
// once to prove a bad frame doesn't stop the next one from rendering),
// sentBeacons collects every navigator.sendBeacon(url, blob) call as
// { url, body } with body already read out of the Blob, for asserting what
// the client error beacon actually reports.
export function driveClientScriptSession(scriptSrc, opts = {}) {
  const {
    location: locationOverrides = {},
    localStorage: initialLocalStorage = {},
    fetch: fetchImpl = () => Promise.reject(new Error('no network in vm-page-driver')),
    // Optional fake window.speechSynthesis + SpeechSynthesisUtterance for TTS tests.
    speechSynthesis: speechSynthesisImpl,
    SpeechSynthesisUtterance: utteranceImpl,
    // Optional navigator.vibrate stub (default no-op) so buzz tests can record patterns.
    vibrate: vibrateImpl = () => {},
    // Extra sandbox globals (e.g. the vitest SSR import binding an interpolated
    // worker.js helper still references when run unbundled).
    extraGlobals = {},
  } = opts;
  FakeEventSource.lastInstance = null;
  FakeEventSource.instances = [];
  const feed = new FakeElement('div');
  const elementsById = new Map([['feed', feed]]);
  const getOrCreate = (id) => {
    if (!elementsById.has(id)) elementsById.set(id, new FakeElement('div'));
    return elementsById.get(id);
  };
  const localStorageStore = new Map(Object.entries(initialLocalStorage));
  const fakeLocalStorage = {
    getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
    setItem: (k, v) => localStorageStore.set(k, String(v)),
    removeItem: (k) => localStorageStore.delete(k),
  };
  // window/document listeners are recorded per type as ARRAYS (the PWA
  // registers several 'visibilitychange' handlers) so dispatchWindow /
  // dispatchDocument can drive the real pagehide / hidden persistence paths.
  const windowListeners = {};
  const documentListeners = {};
  const record = (map) => (type, handler) => { (map[type] ??= []).push(handler); };
  const unrecord = (map) => (type, handler) => { if (map[type]) map[type] = map[type].filter((h) => h !== handler); };
  const dispatch = (map) => (type, ev = {}) => { for (const h of map[type] || []) h(ev); return (map[type] || []).length; };
  const fakeDocument = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeTextNode(text),
    getElementById: (id) => getOrCreate(id),
    addEventListener: record(documentListeners),
    removeEventListener: unrecord(documentListeners),
    visibilityState: 'visible',
    documentElement: { style: {} },
    body: { style: {} },
    querySelectorAll: () => [],
  };
  const sentBeacons = [];
  let pendingTimers = [];
  let timerSeq = 0;
  // setInterval callbacks are recorded (never auto-fired), same as timers;
  // runIntervals(ms) fires every one registered with that period once.
  const intervals = [];
  const baseLocation = { origin: 'https://x', hash: '#t=x', pathname: '/', search: '', href: 'https://x/#t=x', reload: () => {} };
  const location = { ...baseLocation, ...locationOverrides };
  const sandbox = {
    document: fakeDocument,
    window: {
      speechSynthesis: speechSynthesisImpl,
      addEventListener: record(windowListeners),
      removeEventListener: unrecord(windowListeners),
      location,
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    },
    localStorage: fakeLocalStorage,
    EventSource: FakeEventSource,
    navigator: {
      vibrate: vibrateImpl,
      serviceWorker: undefined,
      onLine: true,
      // Blob body content is read synchronously here (fake Blob, see below)
      // rather than via a real Blob.text() promise — keeps the caller sync.
      sendBeacon: (url, blob) => { sentBeacons.push({ url, body: blob && blob._parts ? blob._parts.join('') : String(blob) }); return true; },
    },
    Blob: class FakeBlob { constructor(parts) { this._parts = parts; } },
    location,
    history: { replaceState: () => {} },
    fetch: fetchImpl,
    SpeechSynthesisUtterance: utteranceImpl,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    // Timers are recorded, never auto-fired (same observable behavior as the
    // old no-op stubs); runTimers() on the session object fires the pending
    // set once, in registration order, so a test can drive a scheduled
    // reconnect or a trailing throttled write deterministically.
    setTimeout: (fn, ms) => { pendingTimers.push({ id: ++timerSeq, fn, ms }); return timerSeq; },
    clearTimeout: (id) => { pendingTimers = pendingTimers.filter((t) => t.id !== id); },
    requestAnimationFrame: () => 0,
    console,
    URL,
    URLSearchParams,
    Math,
    Date,
    JSON,
    Set,
    // CSS.escape shim: without it every mark handler threw ReferenceError and the bare catch hid it.
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) },
    Map,
    ...extraGlobals,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox, { filename: 'driven-page-script.js' });

  if (!FakeEventSource.lastInstance) {
    throw new Error('EventSource was never constructed — connect() did not run');
  }
  // Always the CURRENT socket: a reconnect driven via fireError()+runTimers()
  // constructs a new one, and fire/fireEvent/getConnectUrl must follow it the
  // way the page's own `es` binding does. Single-socket tests are unaffected.
  const es = () => FakeEventSource.lastInstance;
  return {
    feed,
    sentBeacons,
    fire: (frame) => es()._onmessage({ data: JSON.stringify(frame) }),
    // Drives a named addEventListener('<type>', ...) handler (e.g. 'status',
    // 'ping', 'mark') through the same {data: JSON string} shape the real
    // EventSource passes onmessage — no-ops if this page never registered
    // that listener, so a caller can tell "not fired" from "not wired" by
    // checking the return value.
    fireEvent: (type, data) => {
      const handler = es()._listeners[type];
      if (!handler) return false;
      handler({ data: JSON.stringify(data) });
      return true;
    },
    fireError: () => { const h = es()._onerror; if (!h) return false; h({}); return true; },
    fireOpen: () => { const h = es()._onopen; if (!h) return false; h({}); return true; },
    getConnectUrl: () => es().url,
    getConnectUrls: () => FakeEventSource.instances.map((s) => s.url),
    getElementById: (id) => elementsById.get(id) || null,
    // Reads the page's fake localStorage (persistence round-trip assertions).
    getStored: (k) => fakeLocalStorage.getItem(k),
    // Fires every timer pending right now (not ones they schedule) and
    // returns how many ran.
    runTimers: () => {
      const batch = pendingTimers;
      pendingTimers = [];
      for (const t of batch) t.fn();
      return batch.length;
    },
    pendingTimerCount: () => pendingTimers.length,
    // Fires each setInterval callback registered with period `ms` once (the
    // page's periodic watchdog/timer ticks); returns how many ran.
    runIntervals: (ms) => {
      const due = intervals.filter((i) => i.ms === ms);
      for (const i of due) i.fn();
      return due.length;
    },
    // Returns the number of handlers that ran, so "not fired" and "not wired"
    // stay distinguishable (same contract as fireEvent).
    dispatchWindow: dispatch(windowListeners),
    dispatchDocument: dispatch(documentListeners),
    setVisibility: (state) => { fakeDocument.visibilityState = state; },
  };
}

// Convenience wrapper for the common one-frame case.
export function driveClientScript(scriptSrc, frame, opts) {
  const { feed, fire } = driveClientScriptSession(scriptSrc, opts);
  fire(frame);
  return feed;
}

export function findFirst(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const c of node.children || []) {
    const found = findFirst(c, predicate);
    if (found) return found;
  }
  return null;
}
