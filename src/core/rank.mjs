// How the launcher turns a query into an order: the whole of the ranking, in one
// place, with no window and no DOM around it, so the rules can be read and tested
// on their own (see test/rank.test.mjs). Lower is better; -1 is no match.
//
//   0  the name is the query
//   1  the name starts with it
//   2  a word in the name starts with it
//   3  it appears inside the name (earlier is better)
//   6  the letters appear in order ("vsc" for Visual Studio Code)
export function score(name, query) {
  const value = String(name || '').toLowerCase();
  const needle = String(query || '').toLowerCase();
  if (!needle) return 0;
  if (value === needle) return 0;
  if (value.startsWith(needle)) return 1;
  if (value.split(/[\s\-_.()]+/).some((word) => word.startsWith(needle))) return 2;
  const inside = value.indexOf(needle);
  if (inside > 0) return 3 + Math.min(inside, 20) / 100;
  let cursor = 0;
  for (const letter of value) {
    if (letter === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 6;
  }
  return -1;
}

// What the rows are drawn from: the matches, best first, ties broken by name so
// the list never jumps around between two keystrokes that score the same.
export function rankEntries(entries, query, limit = 40) {
  const list = Array.isArray(entries) ? entries : [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return list.slice(0, 80);
  const hits = [];
  for (const entry of list) {
    const value = score(entry.name, needle);
    if (value >= 0) hits.push({ entry, value });
  }
  // Ties are broken by name without regard to case, so "Discord" and "discord"
  // keep the order they were found in and the list does not reshuffle between
  // keystrokes that score the same.
  hits.sort(
    (a, b) =>
      a.value - b.value ||
      a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' }),
  );
  return hits.slice(0, limit).map((hit) => hit.entry);
}
