// Tests for driver name matching.
//
// The stakes are asymmetric and the tests are written around that: a false
// "did you mean?" costs one extra tap, a miss costs a split shift history that
// somebody merges by hand in SQL. So the confusable cases are asserted
// generously and the two-different-people cases are asserted hard.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeName,
  nameTokens,
  initials,
  editDistance,
  isConfusable,
  findConfusableDriver,
  findExactDriver,
  searchDrivers,
  orderByRecent,
} from '../js/match.js';

const driver = (id, name) => ({ id, name, active: true });

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------
test('normalizeName casefolds, strips punctuation and collapses whitespace', () => {
  assert.equal(normalizeName("  O'Brien-Smith  "), 'obrien smith');
  assert.equal(normalizeName('MARCUS   T.'), 'marcus t');
});

test('normalizeName strips accents so José and Jose are one person', () => {
  assert.equal(normalizeName('José Álvarez'), normalizeName('Jose Alvarez'));
});

test('normalizeName handles nullish without throwing', () => {
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
});

test('nameTokens returns nothing for an empty name', () => {
  assert.deepEqual(nameTokens('   '), []);
});

test('initials uses first and last token, and copes with one name', () => {
  assert.equal(initials('Marcus Turner'), 'MT');
  assert.equal(initials('Mary Jane Watson'), 'MW');
  assert.equal(initials('Cher'), 'C');
  assert.equal(initials(''), '?');
});

// ---------------------------------------------------------------------------
// edit distance
// ---------------------------------------------------------------------------
test('editDistance measures small edits and bails out past the cap', () => {
  assert.equal(editDistance('smith', 'smyth'), 1);
  assert.equal(editDistance('smith', 'smith'), 0);
  assert.ok(editDistance('smith', 'gonzalez', 2) > 2, 'far-apart names must exceed the cap');
});

// ---------------------------------------------------------------------------
// the case this whole module exists for
// ---------------------------------------------------------------------------
test('isConfusable catches a nickname against a full first name', () => {
  assert.ok(isConfusable('Mike Smith', 'Michael Smith'));
  assert.ok(isConfusable('Michael Smith', 'Mike Smith'));
  assert.ok(isConfusable('Kate Delgado', 'Katherine Delgado'));
});

test('isConfusable catches a suffix being added or dropped', () => {
  assert.ok(isConfusable('Mike Smith Jr', 'Mike Smith'));
});

test('isConfusable catches a typo in either name part', () => {
  assert.ok(isConfusable('Marcus Turnet', 'Marcus Turner'));
  assert.ok(isConfusable('Marcys Turner', 'Marcus Turner'));
});

test('isConfusable ignores case, punctuation and accents', () => {
  assert.ok(!isConfusable('mike smith', 'Mike Smith'), 'an exact match is a hit, not a maybe');
  assert.ok(!isConfusable("O'Brien", 'OBrien'), 'punctuation-only difference is the same name');
});

test('isConfusable does NOT fire on two different people sharing a first name', () => {
  // The expensive false positive: telling Chris Bell he might be Chris Adams.
  assert.ok(!isConfusable('Chris Adams', 'Chris Bell'));
  assert.ok(!isConfusable('Sam Patel', 'Sam Okafor'));
});

test('isConfusable does NOT fire on two different people sharing a surname', () => {
  assert.ok(!isConfusable('Ana Rivera', 'Diego Rivera'));
});

test('isConfusable needs a surname anchor before guessing', () => {
  assert.ok(!isConfusable('Mike Smith', 'Michael Jones'));
});

test('findConfusableDriver returns the closest candidate, or null', () => {
  const drivers = [
    driver('d-1', 'Michael Smith'),
    driver('d-2', 'Chris Bell'),
    driver('d-3', 'Mike Smithson'),
  ];
  assert.equal(findConfusableDriver('Mike Smith', drivers).id, 'd-1');
  assert.equal(findConfusableDriver('Dana Whitfield', drivers), null);
});

test('findConfusableDriver never returns an exact match', () => {
  const drivers = [driver('d-1', 'Mike Smith')];
  assert.equal(findConfusableDriver('mike smith', drivers), null);
});

test('findExactDriver matches across case, punctuation and accents', () => {
  const drivers = [driver('d-1', "Jose O'Neill")];
  assert.equal(findExactDriver("josé o'neill", drivers).id, 'd-1');
  assert.equal(findExactDriver('Jose ONeill', drivers).id, 'd-1');
  assert.equal(findExactDriver('', drivers), null);
});

// ---------------------------------------------------------------------------
// search + ordering
// ---------------------------------------------------------------------------
test('searchDrivers ranks prefix matches above mid-name matches', () => {
  const drivers = [driver('d-1', 'Norma Reyes'), driver('d-2', 'Marcus Turner')];
  assert.deepEqual(
    searchDrivers(drivers, 'ma').map((d) => d.id),
    ['d-2', 'd-1'],
    'somebody typing "ma" means Marcus far more often than Norma',
  );
});

test('searchDrivers matches on a later token, so a surname finds the row', () => {
  const drivers = [driver('d-1', 'Marcus Turner')];
  assert.equal(searchDrivers(drivers, 'turn')[0].id, 'd-1');
});

test('searchDrivers returns nothing for an empty query', () => {
  assert.deepEqual(searchDrivers([driver('d-1', 'Anyone')], '  '), []);
});

test('orderByRecent puts the most recent drivers first, then the rest by name', () => {
  const drivers = [
    driver('d-1', 'Zoe Adams'),
    driver('d-2', 'Marcus Turner'),
    driver('d-3', 'Alicia King'),
  ];
  assert.deepEqual(
    orderByRecent(drivers, ['d-2', 'd-1']).map((d) => d.id),
    ['d-2', 'd-1', 'd-3'],
  );
});

test('orderByRecent does not mutate its input', () => {
  const drivers = [driver('d-1', 'B'), driver('d-2', 'A')];
  orderByRecent(drivers, ['d-2']);
  assert.equal(drivers[0].id, 'd-1');
});

test('isConfusable has a known, accepted false positive on short shared prefixes', () => {
  // Ana and Andrea Rivera are two people, and this fires on them. Kept
  // deliberately: the cost is one extra tap on "No — I'm new", while the
  // opposite error (missing a real Mike/Michael) costs a split shift history
  // that has to be merged by hand in SQL. Documented rather than hidden — if
  // this starts annoying real drivers, tighten the prefix rule in isConfusable.
  assert.ok(isConfusable('Ana Rivera', 'Andrea Rivera'));
});

test('isConfusable catches shortenings that are not plain prefixes', () => {
  // "Mike" is not a prefix of "Michael" — mi-ke vs mi-chael. A naive
  // startsWith test passes every other case here and silently misses this one.
  assert.ok(isConfusable('Mike Smith', 'Michael Smith'));
  assert.ok(isConfusable('Dan Ortega', 'Daniel Ortega'));
});

test('isConfusable handles mononyms, which is what a real roster is full of', () => {
  // Found by running the kiosk against the live database: the roster holds
  // "Mike", not "Michael Smith". A surname-anchored rule alone left this whole
  // protection inert on the data it was written for.
  assert.ok(isConfusable('Michael', 'Mike'));
  assert.ok(isConfusable('Dan', 'Daniel'));
  assert.ok(!isConfusable('Mike', 'Taylor Admin Test'));
  assert.ok(!isConfusable('Sam', 'Pat'));
});

test('isConfusable does not catch nicknames with no shared prefix', () => {
  // Bob/Robert, Bill/William, Peggy/Margaret need a lookup table, not a string
  // rule. Documented as a known miss rather than pretended away.
  assert.ok(!isConfusable('Bob', 'Robert'));
});
