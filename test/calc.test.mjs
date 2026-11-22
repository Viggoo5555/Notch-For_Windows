// The launcher's calculator, held to its answers. Run with `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { calcValue } from '../src/core/calc.mjs';

test('a sum is worked out in the order arithmetic actually has', () => {
  assert.equal(calcValue('2+2'), '4');
  assert.equal(calcValue('2+3*4'), '14');
  assert.equal(calcValue('(2+3)*4'), '20');
  assert.equal(calcValue('-3+1'), '-2');
  assert.equal(calcValue(' 7 / 2 '), '3.5');
});

test('a percent is a fraction, and a comma is a decimal point', () => {
  assert.equal(calcValue('10%'), '0.1');
  assert.equal(calcValue('2,5 * 4'), '10');
  assert.equal(calcValue('200*15%'), '30');
});

test('the × and ÷ keys people actually type are understood', () => {
  assert.equal(calcValue('6×7'), '42');
  assert.equal(calcValue('9÷3'), '3');
});

test('a long decimal is rounded rather than dumped', () => {
  assert.equal(calcValue('1/3'), '0.3333333333');
});

test('what is not a sum comes back as nothing', () => {
  assert.equal(calcValue(''), null);
  assert.equal(calcValue('   '), null);
  assert.equal(calcValue('abc'), null);
  assert.equal(calcValue('2+'), null);
  assert.equal(calcValue('(2+3'), null);
  assert.equal(calcValue('2+2)'), null);
  assert.equal(calcValue('2^8'), null);
  assert.equal(calcValue('1/0'), null);
});

test('an app name that happens to hold a digit is not a sum', () => {
  assert.equal(calcValue('7-Zip'), null);
  assert.equal(calcValue('VLC 3.0'), null);
});
