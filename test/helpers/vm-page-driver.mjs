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
    this.style = {};
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
  addEventListener() {}
  setAttribute() {}
  querySelector() { return null; }
  get offsetHeight() { return 0; }
}

class FakeEventSource {
  constructor() { this._onmessage = null; FakeEventSource.lastInstance = this; }
  set onmessage(fn) { this._onmessage = fn; }
  get onmessage() { return this._onmessage; }
  set onerror(_fn) {}
  set onopen(_fn) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

// Runs `scriptSrc` (one page's extracted <script> body) in a fresh sandbox
// and returns { feed, fire, sentBeacons } — fire(frame) dispatches one more
// SSE message through the real captured onmessage handler (call it more than
// once to prove a bad frame doesn't stop the next one from rendering),
// sentBeacons collects every navigator.sendBeacon(url, blob) call as
// { url, body } with body already read out of the Blob, for asserting what
// the client error beacon actually reports.
export function driveClientScriptSession(scriptSrc) {
  FakeEventSource.lastInstance = null;
  const feed = new FakeElement('div');
  const elementsById = new Map([['feed', feed]]);
  const getOrCreate = (id) => {
    if (!elementsById.has(id)) elementsById.set(id, new FakeElement('div'));
    return elementsById.get(id);
  };
  const localStorageStore = new Map(); // fresh — no keys ever set
  const fakeLocalStorage = {
    getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
    setItem: (k, v) => localStorageStore.set(k, String(v)),
    removeItem: (k) => localStorageStore.delete(k),
  };
  const fakeDocument = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeTextNode(text),
    getElementById: (id) => getOrCreate(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    documentElement: { style: {} },
    body: { style: {} },
    querySelectorAll: () => [],
  };
  const sentBeacons = [];
  const sandbox = {
    document: fakeDocument,
    window: {
      speechSynthesis: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { origin: 'https://x', hash: '#t=x', pathname: '/', reload: () => {} },
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    },
    localStorage: fakeLocalStorage,
    EventSource: FakeEventSource,
    navigator: {
      vibrate: () => {},
      serviceWorker: undefined,
      onLine: true,
      // Blob body content is read synchronously here (fake Blob, see below)
      // rather than via a real Blob.text() promise — keeps the caller sync.
      sendBeacon: (url, blob) => { sentBeacons.push({ url, body: blob && blob._parts ? blob._parts.join('') : String(blob) }); return true; },
    },
    Blob: class FakeBlob { constructor(parts) { this._parts = parts; } },
    location: { origin: 'https://x', hash: '#t=x', pathname: '/', href: 'https://x/#t=x', reload: () => {} },
    history: { replaceState: () => {} },
    fetch: () => Promise.reject(new Error('no network in vm-page-driver')),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    console,
    URL,
    URLSearchParams,
    Math,
    Date,
    JSON,
    Set,
    Map,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox, { filename: 'driven-page-script.js' });

  if (!FakeEventSource.lastInstance) {
    throw new Error('EventSource was never constructed — connect() did not run');
  }
  const es = FakeEventSource.lastInstance;
  return {
    feed,
    sentBeacons,
    fire: (frame) => es._onmessage({ data: JSON.stringify(frame) }),
  };
}

// Convenience wrapper for the common one-frame case.
export function driveClientScript(scriptSrc, frame) {
  const { feed, fire } = driveClientScriptSession(scriptSrc);
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
