// Tests the pure clipboard-observer helper in lib/clipboard.js.
// Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractUrls } from '../lib/clipboard.js';

test('extractUrls returns a single URL', () => {
    assert.deepEqual(extractUrls('https://example.com/file.zip'), ['https://example.com/file.zip']);
});

test('extractUrls returns multiple URLs, one per line', () => {
    const text = 'https://example.com/a.zip\nhttps://example.com/b.zip\n';
    assert.deepEqual(extractUrls(text), ['https://example.com/a.zip', 'https://example.com/b.zip']);
});

test('extractUrls trims whitespace and drops blank lines', () => {
    const text = '  https://example.com/a.zip  \n\n  https://example.com/b.zip\n';
    assert.deepEqual(extractUrls(text), ['https://example.com/a.zip', 'https://example.com/b.zip']);
});

test('extractUrls returns null for plain text', () => {
    assert.equal(extractUrls('just some copied sentence'), null);
});

test('extractUrls returns null when only some lines are links (mixed content)', () => {
    assert.equal(extractUrls('check this out:\nhttps://example.com/a.zip'), null);
});

test('extractUrls returns null for empty or missing input', () => {
    assert.equal(extractUrls(''), null);
    assert.equal(extractUrls(null), null);
    assert.equal(extractUrls(undefined), null);
});

test('extractUrls accepts http and https', () => {
    assert.deepEqual(extractUrls('http://example.com/a.zip'), ['http://example.com/a.zip']);
});
