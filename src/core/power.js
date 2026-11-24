'use strict';

// Keep-awake decisions, kept out of main.js so they can be tested without
// Electron: which of the two holds a setting asks for, how long a window has
// left, and what a spoken order means. Electron's powerSaveBlocker is the only
// thing that actually keeps the machine up; this is the thinking around it.

// The lengths the sheet offers, in minutes. 0 is "until you switch it off",
// which is the switch itself and is what "never" means.
const KEEP_FOR = [0, 30, 60, 120, 240];

// A window is an absolute moment, not a countdown: a laptop that sleeps for an
// hour must not wake up with its hour still to run.
function keepUntilFor(minutes, now = Date.now()) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return now + Math.min(value, 24 * 60) * 60000;
}

function keepLeft(until, now = Date.now()) {
  const value = Number(until) || 0;
  return value ? Math.max(0, value - now) : 0;
}

function keepLeftLabel(until, now = Date.now()) {
  const left = keepLeft(until, now);
  if (!left) return '';
  const minutes = Math.ceil(left / 60000);
  if (minutes <= 1) return 'less than a minute left';
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${String(rest).padStart(2, '0')} min left` : `${hours} h left`;
}

// What the two switches need at this moment. `focus` is a focus session holding
// the screen, which it does whatever the switches say. Electron's display
// blocker already stops the system from sleeping, so the suspension blocker is
// only ever asked for when the screen is free to turn off.
function awakeNeeds(settings, now = Date.now()) {
  const source = settings || {};
  const until = Number(source.keepUntil) || 0;
  const expired = until > 0 && until <= now;
  const live = !expired;
  const display = (live && !!source.keepScreen) || !!source.focus;
  const system = (live && !!source.keepWake) || display;
  return {
    expired,
    display,
    system: system && !display,
    active: display || system,
  };
}

// How long an order asks for, in minutes, or null when it names no length.
// "for 2 hours", "30 min", "half an hour", "i to timer".
const WORDS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fortyfive: 45,
  half: 0.5,
  en: 1,
  et: 1,
  to: 2,
  tre: 3,
  fire: 4,
  fem: 5,
  ti: 10,
  tyve: 20,
  tredive: 30,
  halv: 0.5,
};

function parseKeepDuration(text) {
  const low = String(text || '')
    .toLowerCase()
    .replace(/[\u2019']/g, '');
  if (/\bhalf an hour\b|\bhalf hour\b|\bhalv time\b|\bhalvanden time\b/.test(low)) return 30;
  // Every place a length could be, earliest first: "keep awake i to timer" has a
  // first candidate ("i to") that is not a number, and the one after it is.
  const pattern =
    /(\d+(?:[.,]\d+)?|[a-z\u00e6\u00f8\u00e5]+(?:[\s-][a-z\u00e6\u00f8\u00e5]+)?)\s*(minutes?|minutter|mins?|hours?|timer|hrs?|h)\b/g;
  for (const match of low.matchAll(pattern)) {
    let count = Number(String(match[1]).replace(',', '.'));
    if (!Number.isFinite(count)) {
      // "i to timer" captures "i to", and the number is the last word of it.
      const word = WORDS[match[1].replace(/[\s-]/g, '')] ?? WORDS[match[1].split(/[\s-]/).pop()];
      if (word === undefined) continue;
      count = word;
    }
    if (!Number.isFinite(count) || count <= 0) continue;
    const hours = /^(hours?|timer|hrs?|h)$/.test(match[2]);
    const minutes = Math.round(hours ? count * 60 : count);
    return Math.max(1, Math.min(minutes, 24 * 60));
  }
  return null;
}

// The patch for a change to any of the three switches: the window is derived
// here and never written by hand, so "screen on for an hour" always means one
// hour from the moment it was asked for.
function keepWindowPatch(settings, patch, now = Date.now()) {
  const source = settings || {};
  const asked = patch || {};
  const keepScreen = 'keepScreen' in asked ? !!asked.keepScreen : !!source.keepScreen;
  const keepWake = 'keepWake' in asked ? !!asked.keepWake : !!source.keepWake;
  const raw = Number('keepFor' in asked ? asked.keepFor : source.keepFor) || 0;
  const keepFor = Math.max(0, Math.min(Math.round(raw), 24 * 60));
  const on = keepScreen || keepWake;
  return {
    keepScreen,
    keepWake,
    keepFor,
    keepUntil: on && keepFor > 0 ? keepUntilFor(keepFor, now) : 0,
  };
}

module.exports = {
  KEEP_FOR,
  awakeNeeds,
  keepLeft,
  keepLeftLabel,
  keepUntilFor,
  keepWindowPatch,
  parseKeepDuration,
};
