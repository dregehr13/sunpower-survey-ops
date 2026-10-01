import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const V = require('../lib/qa-vision.cjs');
const QA = require('../lib/qa.cjs');

test('every key photo category has criteria, and nothing else does', () => {
  assert.deepEqual(Object.keys(V.CRITERIA).sort(), QA.KEY_PHOTOS.map(k => k.id).sort());
});

test('the request carries the image and what the category should show', () => {
  const r = V.buildRequest('label', 'AAAA', 'image/jpeg');
  assert.equal(r.model, V.MODEL);
  assert.equal(r.messages[0].content[0].source.data, 'AAAA');
  assert.ok(/label on the main service panel/.test(r.messages[0].content[1].text));
  assert.equal(V.buildRequest('nope', 'AAAA'), null);
});

test('replies are read from JSON, including JSON wrapped in text, and anything else is refused', () => {
  assert.deepEqual(V.parse('{"readable": true, "note": "Reads 200A."}'), { readable: true, note: 'Reads 200A.' });
  assert.equal(V.parse('Sure: {"readable": false, "note": "Too blurry"} done').readable, false);
  assert.equal(V.parse('not json'), null);
  assert.equal(V.parse('{"readable":"yes"}'), null);
});

test('check() sends one request and returns the parsed answer', async () => {
  const seen = [];
  const client = { messages: { create: async r => { seen.push(r); return { content: [{ type: 'text', text: '{"readable":false,"note":"Glare covers the label."}' }] }; } } };
  assert.deepEqual(await V.check(client, 'label', 'AAAA'), { readable: false, note: 'Glare covers the label.' });
  assert.equal(seen.length, 1);
  assert.deepEqual(await V.check(client, 'bogus', 'AAAA'), { error: 'unknown_category' });
});
