// Driver name matching for the kiosk's identity screen.
//
// Pure functions over plain arrays — no DOM, no network — because this is the
// logic that decides whether a person gets their existing history or a brand
// new half-record, and that decision deserves tests rather than eyeballing.
//
// The database already has drivers_name_unique (a unique index on lower(name)),
// which stops "mike smith" from joining "Mike Smith". It does NOT stop "Mike
// Smith" from joining "Michael Smith" — and on a roster that churns, that is
// the case that actually happens. Everything here exists to catch that before
// a second row is written.

// Casefold, strip accents and punctuation, collapse whitespace.
//
// Apostrophes are DELETED while other punctuation becomes a space, and the
// difference matters: "O'Brien" and "OBrien" are one person (delete), but
// "Smith-Jones" and "Smith Jones" are also one person (space). Treating the
// apostrophe as a separator turns "O'Brien" into two tokens and stops it
// matching itself.
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(value) {
  const normalized = normalizeName(value);
  return normalized ? normalized.split(' ') : [];
}

// "Marcus Turner" -> "MT", "Cher" -> "C". Used for the list avatars.
export function initials(value) {
  const tokens = nameTokens(value);
  if (tokens.length === 0) return '?';
  if (tokens.length === 1) return tokens[0][0].toUpperCase();
  return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
}

// Levenshtein, bailed out early once the distance can't come in under `max`.
// Names are short, so the full matrix would be fine; the cap is here to keep
// the intent obvious — this only ever answers "within one or two edits?".
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

// Is `typed` plausibly the same person as `existing`, without being identical?
//
// Deliberately conservative in one direction and generous in the other: a false
// "did you mean?" costs one extra tap, while a miss costs a split history that
// somebody has to merge by hand in SQL later. But it must never fire on two
// genuinely different people, so a shared FIRST name alone is not enough —
// "Chris Adams" and "Chris Bell" are two employees, not a typo.
export function isConfusable(typed, existing) {
  const a = normalizeName(typed);
  const b = normalizeName(existing);
  if (!a || !b || a === b) return false;

  // One name is the other plus more: "Mike Smith" vs "Mike Smith Jr".
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;

  const at = a.split(' ');
  const bt = b.split(' ');

  // Mononyms. A real roster has plenty of these — people enter "Mike", not
  // "Michael Smith" — and with no surname to anchor against, the first name is
  // the only signal there is. So the same nickname and typo shapes apply
  // directly. This does mean a roster genuinely containing both a Dan and a
  // Daniel gets asked; on a roster where people type their own names, that is
  // the right side to err on.
  if (at.length === 1 || bt.length === 1) {
    return firstNamesConfusable(at[0], bt[0]);
  }

  const aLast = at[at.length - 1];
  const bLast = bt[bt.length - 1];
  const aFirst = at[0];
  const bFirst = bt[0];

  // Same surname is the anchor. Without it we do not guess.
  const sameLast = aLast === bLast || (aLast.length >= 4 && editDistance(aLast, bLast, 1) <= 1);
  if (!sameLast) return false;

  return firstNamesConfusable(aFirst, bFirst);
}

// Two given names that plausibly belong to one person.
//
// A plain prefix test does NOT catch the common shortenings — "Mike" is not a
// prefix of "Michael" (mi-ke vs mi-chael), and "Bob" is not one of "Robert".
// So: a typo, a long shared prefix, or a SHORT name sharing a couple of letters
// with a longer one, which is the shape almost every shortening takes
// (Dan/Daniel, Kate/Katherine, Chris/Christopher, Mike/Michael).
//
// Accepted false positive: this also fires on Ana vs Andrea, two real people.
// It costs them one extra tap on "No — I'm new"; missing a genuine Mike/Michael
// costs a split history and a hand-written SQL merge later.
function firstNamesConfusable(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && editDistance(a, b, 1) <= 1) return true;

  const shared = sharedPrefixLength(a, b);
  if (shared >= 3) return true;

  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  return shorter <= 4 && longer > shorter && shared >= 2;
}

function sharedPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

// The closest confusable driver, or null. Exact normalized matches are excluded
// on purpose — those are a straight hit and the caller reuses the row outright
// rather than asking anybody anything.
export function findConfusableDriver(typed, drivers) {
  const candidates = drivers.filter((d) => isConfusable(typed, d.name));
  if (candidates.length === 0) return null;

  const a = normalizeName(typed);
  return candidates.reduce((best, driver) => {
    const score = editDistance(a, normalizeName(driver.name), 99);
    return best === null || score < best.score ? { driver, score } : best;
  }, null).driver;
}

// Exact same-person match, ignoring case, punctuation and accents. The kiosk
// checks this before offering to create anybody.
export function findExactDriver(typed, drivers) {
  const a = normalizeName(typed);
  if (!a) return null;
  return drivers.find((d) => normalizeName(d.name) === a) ?? null;
}

// Substring search, ranked: names that START with the query come first, because
// somebody typing "ma" means Marcus far more often than they mean Norma.
export function searchDrivers(drivers, query) {
  const q = normalizeName(query);
  if (!q) return [];
  const scored = [];
  for (const driver of drivers) {
    const name = normalizeName(driver.name);
    if (name.startsWith(q)) scored.push({ driver, rank: 0 });
    else if (name.split(' ').some((token) => token.startsWith(q))) scored.push({ driver, rank: 1 });
    else if (name.includes(q)) scored.push({ driver, rank: 2 });
  }
  scored.sort((x, y) => x.rank - y.rank || x.driver.name.localeCompare(y.driver.name));
  return scored.map((s) => s.driver);
}

// Recent drivers first, in the order they last drove, then everyone else
// alphabetically. On a churning roster this is what stops most people ever
// having to type: whoever drove this week is overwhelmingly who is driving now.
export function orderByRecent(drivers, recentDriverIds) {
  const rank = new Map(recentDriverIds.map((id, index) => [id, index]));
  return [...drivers].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}
