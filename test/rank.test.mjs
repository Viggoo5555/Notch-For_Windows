// The launcher's ranking, held to its rules. Run with `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { score, rankEntries } from '../src/core/rank.mjs';

test('an exact name beats everything', () => {
  assert.equal(score('Steam', 'steam'), 0);
  assert.equal(score('steam', 'STEAM'), 0);
});

test('a prefix beats a word, and a word beats a substring', () => {
  const prefix = score('Codeblocks', 'code');
  const word = score('Visual Studio Code', 'code');
  const inside = score('Barcode Reader', 'code');
  assert.ok(prefix < word, `${prefix} < ${word}`);
  assert.ok(word < inside, `${word} < ${inside}`);
});

test('an earlier substring ranks higher than a later one', () => {
  // No separators, or both would count as a word starting with the query.
  assert.ok(score('abx', 'x') < score('abyx', 'x'));
});

test('the letters in order are the last thing that counts', () => {
  assert.equal(score('Visual Studio Code', 'vsc'), 6);
  assert.equal(score('Visual Studio Code', 'zzz'), -1);
});

test('an empty query matches everything at the same score', () => {
  assert.equal(score('anything', ''), 0);
});

test('entries come back best first, ties in name order', () => {
  const entries = [
    { name: 'Discord' },
    { name: 'Discord Canary' },
    { name: 'discord' },
    { name: 'Slack' },
  ];
  const ranked = rankEntries(entries, 'discord').map((entry) => entry.name);
  // The exact name first, then the two that start with it, in name order; Slack
  // does not match at all.
  assert.deepEqual(ranked, ['Discord', 'discord', 'Discord Canary']);
});

test('an empty query is the first page of everything', () => {
  const entries = Array.from({ length: 120 }, (_, index) => ({ name: `App ${index}` }));
  assert.equal(rankEntries(entries, '').length, 80);
  assert.equal(rankEntries(entries, 'app').length, 40);
});

test('the limit is kept and nothing else is returned', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ name: `App ${index}` }));
  assert.equal(rankEntries(entries, 'app', 3).length, 3);
  assert.deepEqual(rankEntries(null, 'x'), []);
});
