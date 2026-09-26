import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanText, formatTime, clampLimit } from '../build/index.js';

test('cleanText decodes the numeric entities HN actually serves', () => {
  assert.equal(cleanText('it&#x27;s &#x2F; done'), "it's / done");
  assert.equal(cleanText('a &amp; b &quot;c&quot;'), 'a & b "c"');
  assert.equal(cleanText('&#8217;'), '’');
});

test('cleanText turns paragraph markup into blank lines, not mush', () => {
  assert.equal(cleanText('one<p>two'), 'one\n\ntwo');
  assert.equal(cleanText('a<br>b'), 'a\nb');
  assert.equal(cleanText('<i>tagged</i>'), 'tagged');
  assert.equal(cleanText(undefined), '');
});

test('formatTime is locale-independent ISO 8601', () => {
  assert.equal(formatTime(0), '1970-01-01T00:00:00Z');
  assert.equal(formatTime(1700000000), '2023-11-14T22:13:20Z');
});

test('clampLimit keeps callers inside the advertised range', () => {
  assert.equal(clampLimit(undefined, 10, 50), 10);
  assert.equal(clampLimit(999, 10, 50), 50);
  assert.equal(clampLimit(0, 10, 50), 1);
  assert.equal(clampLimit(-5, 10, 50), 1);
  assert.equal(clampLimit(25, 10, 50), 25);
  assert.equal(clampLimit('nope', 10, 50), 10);
  assert.equal(clampLimit(NaN, 10, 50), 10);
});
