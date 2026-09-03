// Minimal fake DOM for buildRow's unit + parity tests. Deliberately does NOT
// use jsdom/happy-dom — buildRow's own contract is "never reads a global
// `document`, everything arrives via opts.doc" (src/lib.js), and a fake doc
// this small makes any accidental `document.foo` reference surface as a
// plain ReferenceError under plain Node, which is exactly the proof
// gate-2 condition 2 asked for.
//
// Structurally mirrors the same fake DOM used by
// scripts/../gen-golden.mjs (throwaway, not committed) to generate
// test/fixtures/buildrow-golden.json, so serialize() here produces the same
// shape the fixture was written in.

export class FakeTextNode {
  constructor(text) {
    this.nodeType = 'text';
    this.text = text;
  }
}

export class FakeElement {
  constructor(tag) {
    this.nodeType = 'element';
    this.tagName = tag;
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.src = undefined;
    this.alt = undefined;
    this.loading = undefined;
    this.onerror = undefined;
  }
  append(...items) {
    for (const it of items) {
      this.children.push(typeof it === 'string' ? new FakeTextNode(it) : it);
    }
  }
  set textContent(v) {
    this.children = [new FakeTextNode(v)];
  }
  get textContent() {
    return this.children.map((c) => (c.nodeType === 'text' ? c.text : c.textContent)).join('');
  }
}

export function createFakeDocument() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeTextNode(text),
  };
}

// Serializes a FakeElement/FakeTextNode tree into the same plain-object shape
// committed in test/fixtures/buildrow-golden.json — undefined fields are
// omitted by JSON.stringify's normal behavior, so this stays diff-friendly.
export function serializeNode(node) {
  if (!node) return null;
  if (node.nodeType === 'text') return { text: node.text };
  const out = { tag: node.tagName };
  if (node.className) out.className = node.className;
  if (node.dataset && Object.keys(node.dataset).length) out.dataset = { ...node.dataset };
  if (node.src !== undefined) out.src = node.src;
  if (node.alt !== undefined) out.alt = node.alt;
  if (node.loading !== undefined) out.loading = node.loading;
  if (node.children && node.children.length) out.children = node.children.map(serializeNode);
  return out;
}
