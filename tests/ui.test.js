// Tests for the pure helpers in js/ui.js. The escaping cases are the important
// ones: that bug was a live stored-XSS hole and is trivially checkable.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  safeHex,
  inkOn,
  formatElapsed,
  formatRelativeDays,
  frequencyLabel,
  isNeedsCleaning,
  isTaskDue,
  isTaskFinished,
  scheduleLabel,
  priorityLabel,
  sortSlowTasks,
  isShiftOverdue,
} from '../js/ui.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
test('escapeHtml escapes quotes, which is what made attribute breakout possible', () => {
  // The old implementation (textContent -> innerHTML) left both quote
  // characters untouched, so any attr="${escapeHtml(v)}" was injectable.
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml neutralises the stored-XSS payload a driver could self-register', () => {
  const payload = '" onfocus="alert(document.domain)" autofocus x="';
  const rendered = `<input value="${escapeHtml(payload)}" />`;

  assert.ok(!/value="[^"]*"\s+onfocus=/.test(rendered), 'must not close the value attribute early');
  assert.ok(!rendered.includes('onfocus="alert'), 'must not emit a live event handler');
});

test('escapeHtml escapes the full set', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('escapeHtml renders nullish as empty rather than "null"', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml stringifies non-strings', () => {
  assert.equal(escapeHtml(7), '7');
  assert.equal(escapeHtml(false), 'false');
});

// ---------------------------------------------------------------------------
// safeHex
// ---------------------------------------------------------------------------
test('safeHex accepts 3, 6 and 8 digit hex', () => {
  assert.equal(safeHex('#abc'), '#abc');
  assert.equal(safeHex('#C8102E'), '#C8102E');
  assert.equal(safeHex('#c8102e80'), '#c8102e80');
});

test('safeHex rejects CSS injection through a style attribute', () => {
  // Escaping alone would not stop this, since it contains no quotes.
  assert.equal(safeHex('red;background-image:url(https://evil.example/x)'), '#b9b3a7');
});

test('safeHex falls back for junk and nullish input', () => {
  assert.equal(safeHex('rebeccapurple'), '#b9b3a7');
  assert.equal(safeHex(null), '#b9b3a7');
  assert.equal(safeHex('#12345'), '#b9b3a7');
  assert.equal(safeHex('#zzz'), '#b9b3a7');
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------
test('formatElapsed uses minutes under an hour', () => {
  assert.equal(formatElapsed(ago(14 * 60 * 1000)), '14m');
});

test('formatElapsed uses zero-padded minutes within a day', () => {
  assert.equal(formatElapsed(ago(HOUR + 5 * 60 * 1000)), '1h 05m');
});

test('formatElapsed switches to days past 24 hours', () => {
  assert.equal(formatElapsed(ago(3 * DAY + 4 * HOUR)), '3d 04h');
});

test('formatElapsed clamps a future timestamp to zero rather than going negative', () => {
  assert.equal(formatElapsed(new Date(Date.now() + HOUR).toISOString()), '0m');
});

test('formatElapsed handles a missing timestamp', () => {
  assert.equal(formatElapsed(null), '—');
});

// ---------------------------------------------------------------------------
// formatRelativeDays
// ---------------------------------------------------------------------------
test('formatRelativeDays reads naturally near today', () => {
  assert.equal(formatRelativeDays(ago(2 * HOUR)), 'today');
  assert.equal(formatRelativeDays(ago(DAY + HOUR)), 'yesterday');
  assert.equal(formatRelativeDays(ago(9 * DAY)), '9 days ago');
});

test('formatRelativeDays uses the caller fallback when never recorded', () => {
  assert.equal(formatRelativeDays(null), 'never');
  assert.equal(formatRelativeDays(null, 'no record'), 'no record');
});

// ---------------------------------------------------------------------------
// isShiftOverdue
// ---------------------------------------------------------------------------
test('isShiftOverdue leaves a normal shift alone', () => {
  const now = Date.parse('2026-08-19T20:00:00Z');
  assert.equal(isShiftOverdue('2026-08-19T12:00:00Z', now), false, '8h is a long but real shift');
});

test('isShiftOverdue flags a shift left open overnight', () => {
  const now = Date.parse('2026-08-20T08:00:00Z');
  assert.equal(isShiftOverdue('2026-08-19T12:00:00Z', now), true);
});

test('isShiftOverdue does not fire exactly on the threshold', () => {
  const start = '2026-08-19T12:00:00Z';
  assert.equal(isShiftOverdue(start, Date.parse(start) + 12 * HOUR), false);
  assert.equal(isShiftOverdue(start, Date.parse(start) + 12 * HOUR + 1), true);
});

test('isShiftOverdue treats a missing start time as not overdue', () => {
  assert.equal(isShiftOverdue(null), false);
});

// ---------------------------------------------------------------------------
// isNeedsCleaning
// ---------------------------------------------------------------------------
test('isNeedsCleaning respects each bag its own window', () => {
  const cleaned = ago(8 * DAY);
  assert.equal(isNeedsCleaning({ last_cleaned: cleaned, clean_window_days: 7 }), true);
  assert.equal(isNeedsCleaning({ last_cleaned: cleaned, clean_window_days: 14 }), false);
});

test('isNeedsCleaning flags a bag that has never been cleaned', () => {
  assert.equal(isNeedsCleaning({ last_cleaned: null, clean_window_days: 30 }), true);
});

test('isNeedsCleaning falls back to the configured default window', () => {
  // Covers a bag row predating the clean_window_days column.
  assert.equal(isNeedsCleaning({ last_cleaned: ago(9 * DAY) }), true);
  assert.equal(isNeedsCleaning({ last_cleaned: ago(2 * DAY) }), false);
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
test('isTaskDue compares next_due against now', () => {
  assert.equal(isTaskDue({ next_due: ago(DAY) }), true);
  assert.equal(isTaskDue({ next_due: new Date(Date.now() + DAY).toISOString() }), false);
});

test('frequencyLabel names the common cadences', () => {
  assert.equal(frequencyLabel(1), 'Daily');
  assert.equal(frequencyLabel(7), 'Weekly');
  assert.equal(frequencyLabel(14), 'Every 2 weeks');
  assert.equal(frequencyLabel(30), 'Monthly');
  assert.equal(frequencyLabel(45), 'Every 45 days');
});

// ---------------------------------------------------------------------------
// inkOn — contrast against operator-chosen vehicle colours
// ---------------------------------------------------------------------------
test('inkOn picks dark ink on a light fill and light ink on a dark one', () => {
  // The bug this exists for: the kiosk painted a white car glyph onto a tile
  // filled with the vehicle's own colour, so "White Car" (#e8e6e1) rendered
  // white-on-near-white and vanished on the wall.
  assert.equal(inkOn('#e8e6e1'), '#1c1a16', 'White Car must get dark ink');
  assert.equal(inkOn('#1c1c1c'), '#ffffff', 'Black Car must get light ink');
  assert.equal(inkOn('#c8102e'), '#ffffff', 'Red Car must get light ink');
  assert.equal(inkOn('#1f6fb2'), '#ffffff', 'Blue Car must get light ink');
});

test('inkOn expands shorthand hex and tolerates junk', () => {
  assert.equal(inkOn('#fff'), '#1c1a16');
  assert.equal(inkOn('#000'), '#ffffff');
  assert.equal(inkOn('not-a-colour'), '#ffffff', 'unparseable input falls back to light ink');
  assert.equal(inkOn(null), '#ffffff');
});

test('inkOn ignores an alpha channel rather than misreading it as colour', () => {
  assert.equal(inkOn('#e8e6e100'), '#1c1a16');
});

// ---------------------------------------------------------------------------
// repeating vs one-time slow tasks
// ---------------------------------------------------------------------------
test('a completed one-time task is finished and stops reading as due', () => {
  const task = { repeats: false, last_completed: ago(DAY), next_due: ago(10 * DAY) };

  assert.equal(isTaskFinished(task), true);
  assert.equal(isTaskDue(task), false, 'a one-off has no cadence to come back on');
});

test('an uncompleted one-time task is due once its date passes', () => {
  assert.equal(isTaskDue({ repeats: false, last_completed: null, next_due: ago(DAY) }), true);
  assert.equal(isTaskFinished({ repeats: false, last_completed: null, next_due: ago(DAY) }), false);
});

test('a repeating task is never finished, however many times it has been done', () => {
  const task = { repeats: true, frequency_days: 30, last_completed: ago(DAY), next_due: ago(DAY) };

  assert.equal(isTaskFinished(task), false);
  assert.equal(isTaskDue(task), true);
});

test('a row from before the migration has no repeats column and stays repeating', () => {
  // `!task.repeats` would read undefined as "one-off" and silently retire every
  // existing task the first time it was completed.
  const legacy = { frequency_days: 7, last_completed: ago(DAY), next_due: ago(DAY) };

  assert.equal(isTaskFinished(legacy), false);
  assert.equal(isTaskDue(legacy), true);
});

test('scheduleLabel answers the cadence question for both kinds of task', () => {
  assert.equal(scheduleLabel({ repeats: false }), 'One-time');
  assert.equal(scheduleLabel({ repeats: true, frequency_days: 14 }), 'Every 2 weeks');
  assert.equal(scheduleLabel({ frequency_days: 30 }), 'Monthly');
});

// ---------------------------------------------------------------------------
// slow task priority
// ---------------------------------------------------------------------------
test('priorityLabel falls back to normal for missing or junk values', () => {
  assert.equal(priorityLabel('high'), 'High');
  assert.equal(priorityLabel(undefined), 'Normal');
  assert.equal(priorityLabel('urgent'), 'Normal');
});

test('sortSlowTasks puts high priority first, then the soonest due', () => {
  const tasks = [
    { name: 'low-soon', priority: 'low', next_due: ago(9 * DAY) },
    { name: 'normal', priority: 'normal', next_due: ago(8 * DAY) },
    { name: 'high-late', priority: 'high', next_due: ago(DAY) },
    { name: 'high-early', priority: 'high', next_due: ago(5 * DAY) },
  ];

  assert.deepEqual(
    sortSlowTasks(tasks).map((t) => t.name),
    ['high-early', 'high-late', 'normal', 'low-soon'],
    'priority is the tiebreak; within a priority the oldest due date leads',
  );
});

test('sortSlowTasks does not mutate the list it was handed', () => {
  const tasks = [
    { name: 'a', priority: 'low', next_due: ago(DAY) },
    { name: 'b', priority: 'high', next_due: ago(DAY) },
  ];

  sortSlowTasks(tasks);

  assert.deepEqual(tasks.map((t) => t.name), ['a', 'b']);
});
