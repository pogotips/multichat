import { describe, it, expect } from 'vitest';
import {
  estimateTokens, neuronsFor, NEURON_RATES, normalizeForCompare, extractModelText, translateLabel,
  translateRequestText, TRANSLATE_TEXT_MAX,
} from '../src/lib.js';

describe('estimateTokens / neuronsFor', () => {
  it('estimates ~4 chars per token, 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens(undefined)).toBe(0);
  });
  it('prices per million tokens', () => {
    expect(neuronsFor(1_000_000, 0)).toBe(9091);
    expect(neuronsFor(0, 1_000_000)).toBe(27273);
    expect(neuronsFor(NaN, undefined)).toBe(0);
  });
  it('takes explicit per-model rates', () => {
    const llama = NEURON_RATES['@cf/meta/llama-3.1-8b-instruct-fp8-fast'];
    expect(neuronsFor(1_000_000, 0, llama)).toBe(4119);
    expect(neuronsFor(0, 1_000_000, llama)).toBe(34868);
    expect(neuronsFor(1_000_000, 0, NEURON_RATES['@cf/google/gemma-4-26b-a4b-it'])).toBe(9091);
  });
});

describe('normalizeForCompare', () => {
  it('ignores case and punctuation', () => {
    expect(normalizeForCompare('Hello, world!')).toBe(normalizeForCompare('hello world'));
  });
});

describe('extractModelText', () => {
  it('reads response', () => expect(extractModelText({ response: ' hi ' })).toBe('hi'));
  it('reads chat-completions shape', () => {
    expect(extractModelText({ choices: [{ message: { content: 'yo' } }] })).toBe('yo');
  });
  it('strips think blocks', () => {
    expect(extractModelText({ response: '<think>hmm\nmore</think>Hello' })).toBe('Hello');
  });
  it('joins array-of-parts content', () => {
    expect(extractModelText({ choices: [{ message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }] } }] })).toBe('Hello there');
  });
  it('null content -> empty', () => {
    expect(extractModelText({ choices: [{ message: { content: null } }] })).toBe('');
  });
  it('ignores non-text parts', () => {
    expect(extractModelText({ choices: [{ message: { content: [{ type: 'image', url: 'u' }, null, 5, { type: 'text', text: 'ok' }, { type: 'text', text: 7 }] } }] })).toBe('ok');
  });
  it('non-object -> empty', () => {
    expect(extractModelText(null)).toBe('');
    expect(extractModelText('x')).toBe('');
    expect(extractModelText({})).toBe('');
  });
});

describe('translateLabel', () => {
  it.each([
    ['translating', 'translating…'],
    ['same', 'already English'],
    ['empty', 'nothing to translate'],
    ['minute', 'limit hit'],
    ['budget', 'limit hit'],
    ['http_500', 'failed'],
    [undefined, 'failed'],
  ])('%s -> %s', (r, label) => expect(translateLabel(r)).toBe(label));
});

describe('translateRequestText', () => {
  it('strips emotes, urls and control chars', () => {
    const t = translateRequestText('Kappa hola\x00 https://example.com/x amigo', [{ id: '25', start: 0, end: 4 }]);
    expect(t).toBe('hola amigo');
  });
  it('caps at 300', () => {
    expect(TRANSLATE_TEXT_MAX).toBe(300);
    expect(translateRequestText('a'.repeat(900)).length).toBe(300);
  });
  it('emote-only -> empty', () => {
    expect(translateRequestText('Kappa', [{ id: '25', start: 0, end: 4 }])).toBe('');
  });
});
