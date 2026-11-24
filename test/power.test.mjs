import test from 'node:test';
import assert from 'node:assert/strict';

import power from '../src/core/power.js';

const {
  awakeNeeds,
  keepLeft,
  keepLeftLabel,
  keepUntilFor,
  keepWindowPatch,
  parseKeepDuration,
} = power;

const NOW = 1_700_000_000_000;

test('a length becomes a moment, and never means no moment at all', () => {
  assert.equal(keepUntilFor(0, NOW), 0);
  assert.equal(keepUntilFor(30, NOW), NOW + 30 * 60000);
  assert.equal(keepUntilFor(undefined, NOW), 0);
  // Longer than a day is a day: a typo should not hold a machine up forever.
  assert.equal(keepUntilFor(5000, NOW), NOW + 24 * 60 * 60000);
});

test('a window past its end has nothing left, not a negative', () => {
  assert.equal(keepLeft(NOW - 5000, NOW), 0);
  assert.equal(keepLeft(NOW + 60000, NOW), 60000);
  assert.equal(keepLeft(0, NOW), 0);
});

test('the label counts minutes, then hours, then nothing', () => {
  assert.equal(keepLeftLabel(0, NOW), '');
  assert.equal(keepLeftLabel(NOW - 1, NOW), '');
  assert.equal(keepLeftLabel(NOW + 20_000, NOW), 'less than a minute left');
  assert.equal(keepLeftLabel(NOW + 9 * 60000, NOW), '9 min left');
  assert.equal(keepLeftLabel(NOW + 60 * 60000, NOW), '1 h left');
  assert.equal(keepLeftLabel(NOW + 125 * 60000, NOW), '2 h 05 min left');
});

test('the screen hold alone is enough for the machine to stay up', () => {
  const both = awakeNeeds({ keepScreen: true, keepWake: true }, NOW);
  assert.deepEqual(both, { expired: false, display: true, system: false, active: true });

  const pcOnly = awakeNeeds({ keepScreen: false, keepWake: true }, NOW);
  assert.deepEqual(pcOnly, { expired: false, display: false, system: true, active: true });

  const off = awakeNeeds({}, NOW);
  assert.deepEqual(off, { expired: false, display: false, system: false, active: false });
});

test('a spent window lets go, and says it did', () => {
  const spent = awakeNeeds({ keepScreen: true, keepWake: true, keepUntil: NOW - 1 }, NOW);
  assert.equal(spent.expired, true);
  assert.equal(spent.active, false);

  const running = awakeNeeds({ keepScreen: true, keepUntil: NOW + 1000 }, NOW);
  assert.equal(running.expired, false);
  assert.equal(running.display, true);
});

test('a focus session holds the screen whatever the switches say', () => {
  const focus = awakeNeeds({ focus: true }, NOW);
  assert.equal(focus.display, true);
  assert.equal(focus.system, false);
  // Even after a window ran out: the session is the newer reason.
  const after = awakeNeeds({ keepScreen: true, keepUntil: NOW - 1, focus: true }, NOW);
  assert.equal(after.display, true);
});

test('a change derives the window from the moment it was asked for', () => {
  assert.deepEqual(keepWindowPatch({}, { keepScreen: true, keepFor: 60 }, NOW), {
    keepScreen: true,
    keepWake: false,
    keepFor: 60,
    keepUntil: NOW + 60 * 60000,
  });
  // "until off" holds nothing and stores no window.
  assert.deepEqual(keepWindowPatch({ keepScreen: true, keepFor: 60 }, { keepFor: 0 }, NOW), {
    keepScreen: true,
    keepWake: false,
    keepFor: 0,
    keepUntil: 0,
  });
  // Switching both off ends the window even if a length is still chosen.
  assert.deepEqual(
    keepWindowPatch({ keepScreen: true, keepWake: true, keepFor: 30 }, { keepScreen: false, keepWake: false }, NOW),
    {
    keepScreen: false,
    keepWake: false,
      keepFor: 30,
      keepUntil: 0,
    },
  );
});

test('lengths can be spoken, written in digits, or in Danish', () => {
  assert.equal(parseKeepDuration('keep the screen awake for 2 hours'), 120);
  assert.equal(parseKeepDuration('keep the pc awake for 30 min'), 30);
  assert.equal(parseKeepDuration('keep awake for half an hour'), 30);
  assert.equal(parseKeepDuration('keep awake i to timer'), 120);
  assert.equal(parseKeepDuration('hold skærmen vågen i 45 minutter'), 45);
  assert.equal(parseKeepDuration('keep the screen awake'), null);
  assert.equal(parseKeepDuration(''), null);
  // The window is clamped to a day like everything else.
  assert.equal(parseKeepDuration('keep awake for 999 hours'), 24 * 60);
  // A number with no unit is not a length.
  assert.equal(parseKeepDuration('keep awake for 2'), null);
});

test('the sheet lengths are the ones the module knows', () => {
  assert.deepEqual(power.KEEP_FOR, [0, 30, 60, 120, 240]);
});
