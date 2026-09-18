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
  taskStatus,
  taskSchedule,
  taskIntervalMinutes,
  intervalLabel,
  parseClockTime,
  clockValue,
  taskDueTimes,
  untilLabel,
  completionNames,
  formatRelativeTime,
  startOfTodayIso,
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

// ---------------------------------------------------------------------------
// schedule normalising — the app is deployed before the SQL is run, every time
// ---------------------------------------------------------------------------
test('a row from before the schedule column falls back to what it used to mean', () => {
  assert.equal(taskSchedule({ frequency_days: 7 }), 'interval');
  assert.equal(taskSchedule({ repeats: false }), 'once');
  assert.equal(taskSchedule({ repeats: true, frequency_days: 7 }), 'interval');
  assert.equal(taskSchedule({ schedule: 'times_per_day' }), 'times_per_day');
});

test('a cadence reads the same whether it was stored in days or minutes', () => {
  assert.equal(taskIntervalMinutes({ frequency_minutes: 120 }), 120);
  assert.equal(taskIntervalMinutes({ frequency_days: 30 }), 43200);
  assert.equal(taskIntervalMinutes({}), null);
});

test('intervalLabel names the common cadences and stays readable for the rest', () => {
  assert.equal(intervalLabel(60), 'Hourly');
  assert.equal(intervalLabel(1440), 'Daily');
  assert.equal(intervalLabel(10080), 'Weekly');
  assert.equal(intervalLabel(43200), 'Monthly');
  assert.equal(intervalLabel(120), 'Every 2 hours');
  assert.equal(intervalLabel(45), 'Every 45 minutes');
  assert.equal(intervalLabel(4320), 'Every 3 days');
  assert.equal(intervalLabel(null), 'No cadence set');
});

// ---------------------------------------------------------------------------
// interval schedules, now that they can be shorter than a day
// ---------------------------------------------------------------------------
test('an interval task comes back once its next_due passes, however short', () => {
  const twoHourly = { schedule: 'interval', frequency_minutes: 120 };

  assert.equal(isTaskDue({ ...twoHourly, next_due: ago(10 * 60000) }), true);
  assert.equal(isTaskDue({ ...twoHourly, next_due: new Date(Date.now() + HOUR).toISOString() }), false);
});

// ---------------------------------------------------------------------------
// times_of_day
// ---------------------------------------------------------------------------
const AT = (h, m = 0) => new Date(2026, 8, 18, h, m);
const lot = { schedule: 'times_of_day', due_times: ['08:00:00', '13:00:00', '18:00:00'] };

test('a times_of_day task is due once a slot has come round and nobody has done it', () => {
  assert.equal(isTaskDue({ ...lot, last_completed: null }, { now: AT(14) }), true);
});

test('completing a slot clears it until the next one comes round', () => {
  const done = { ...lot, last_completed: AT(13, 10).toISOString() };

  assert.equal(isTaskDue(done, { now: AT(14) }), false, 'the 1pm run is answered');
  assert.equal(isTaskDue(done, { now: AT(18, 30) }), true, 'the 6pm run is its own run');
});

test('a slot that passes uncompleted stays missed rather than sliding forward', () => {
  // Done at 8:05, nothing since. At 2pm the 1pm run is outstanding, and the
  // morning completion must not count for it.
  const status = taskStatus({ ...lot, last_completed: AT(8, 5).toISOString() }, { now: AT(14) });

  assert.equal(status.due, true);
  assert.equal(status.slotAt.getHours(), 13);
});

test('before the first slot of the day, the outstanding run is yesterdays last', () => {
  // Without the wrap-around an evening-only task reads "not due" all night —
  // exactly when somebody is at the board wondering whether it got done.
  const status = taskStatus({ ...lot, last_completed: null }, { now: AT(6) });

  assert.equal(status.due, true);
  assert.equal(status.slotAt.getDate(), 17, "yesterday's 6pm run");
  assert.equal(status.slotAt.getHours(), 18);
});

test('a not-yet-due times_of_day task points at the next slot', () => {
  const status = taskStatus({ ...lot, last_completed: AT(13, 10).toISOString() }, { now: AT(14) });

  assert.equal(status.due, false);
  assert.equal(status.nextAt.getHours(), 18);
});

test('after the last slot, the next one is tomorrow morning', () => {
  const status = taskStatus({ ...lot, last_completed: AT(18, 5).toISOString() }, { now: AT(20) });

  assert.equal(status.nextAt.getDate(), 19);
  assert.equal(status.nextAt.getHours(), 8);
});

test('clock times survive the Postgres round trip and unparseable ones are dropped', () => {
  assert.equal(parseClockTime('08:00:00'), 480);
  assert.equal(parseClockTime('13:45'), 825);
  assert.equal(parseClockTime('25:00'), null);
  assert.equal(parseClockTime(''), null);
  assert.deepEqual(taskDueTimes({ due_times: ['18:00', 'nonsense', '08:00'] }), [480, 1080]);
  assert.equal(clockValue(480), '08:00');
  assert.equal(clockValue(825), '13:45');
});

// ---------------------------------------------------------------------------
// times_per_day — the one that lets a second person take a run at it
// ---------------------------------------------------------------------------
const counter = { schedule: 'times_per_day', times_per_day: 3 };

test('a times_per_day task stays available until the day is used up', () => {
  assert.equal(isTaskDue(counter, { doneToday: 0 }), true);
  assert.equal(isTaskDue(counter, { doneToday: 2 }), true, 'one run left, so somebody else can take it');
  assert.equal(isTaskDue(counter, { doneToday: 3 }), false);
});

test('a times_per_day task reports its progress so the board can show it', () => {
  const status = taskStatus(counter, { doneToday: 1 });

  assert.equal(status.doneToday, 1);
  assert.equal(status.target, 3);
});

test('an unreadable completion count shows the task as still needing doing', () => {
  // The counts read is best-effort on both boards. Over-showing is the safe way
  // to be wrong; a silently hidden task is not.
  assert.equal(isTaskDue(counter), true);
});

test('a times_per_day task that is done for today comes back at midnight', () => {
  const now = AT(20);
  const status = taskStatus(counter, { doneToday: 3, now });

  assert.equal(status.due, false);
  assert.equal(status.nextAt.getDate(), 19);
  assert.equal(status.nextAt.getHours(), 0);
});

test('a one-off is still finished once, whatever else changed', () => {
  assert.equal(isTaskFinished({ schedule: 'once', last_completed: ago(DAY), next_due: ago(2 * DAY) }), true);
  assert.equal(isTaskFinished({ schedule: 'times_per_day', times_per_day: 2, last_completed: ago(DAY) }), false);
});

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------
test('scheduleLabel answers "how often" for all four schedules', () => {
  assert.equal(scheduleLabel({ schedule: 'once' }), 'One-time');
  assert.equal(scheduleLabel({ schedule: 'interval', frequency_minutes: 120 }), 'Every 2 hours');
  assert.equal(scheduleLabel({ schedule: 'times_per_day', times_per_day: 3 }), '3\u00d7 per day');
  assert.match(scheduleLabel(lot), /^At /);
  assert.equal(scheduleLabel({ schedule: 'times_of_day', due_times: [] }), 'No times set');
});

test('formatRelativeTime resolves inside the day, where formatRelativeDays gives up', () => {
  assert.equal(formatRelativeTime(ago(30 * 1000)), 'just now');
  assert.equal(formatRelativeTime(ago(20 * 60 * 1000)), '20m ago');
  assert.equal(formatRelativeTime(ago(3 * HOUR)), '3h ago');
  assert.equal(formatRelativeTime(ago(2 * DAY)), '2 days ago');
  assert.equal(formatRelativeTime(null), 'never');
});

test('untilLabel counts down in the unit that is actually useful', () => {
  const now = new Date(2026, 8, 18, 9, 0);
  const ahead = (ms) => new Date(now.getTime() + ms);

  assert.equal(untilLabel(ahead(-1000), now), 'now');
  assert.equal(untilLabel(ahead(25 * 60 * 1000), now), 'in 25 min');
  assert.equal(untilLabel(ahead(3 * HOUR), now), 'in 3 hours');
  assert.equal(untilLabel(ahead(9 * DAY), now), 'in 9 days');
  assert.equal(untilLabel(null, now), null);
});

test('untilLabel counts calendar days, so 28 hours can be either answer', () => {
  // 28 hours from 9am lands tomorrow lunchtime; 28 hours from 9pm lands the day
  // after. Ceil-ing the elapsed milliseconds calls both of them the same thing.
  const morning = new Date(2026, 8, 18, 9, 0);
  const evening = new Date(2026, 8, 18, 21, 0);

  assert.equal(untilLabel(new Date(morning.getTime() + 28 * HOUR), morning), 'tomorrow');
  assert.equal(untilLabel(new Date(evening.getTime() + 28 * HOUR), evening), 'in 2 days');
});

test('sorting tolerates a clock-based task, which stores no next_due at all', () => {
  // Sorting on a raw null parks a times_of_day task at the epoch and floats it
  // above everything else.
  const tasks = [
    { name: 'clock', priority: 'normal', due_times: ['08:00'], schedule: 'times_of_day', last_completed: ago(HOUR) },
    { name: 'soon', priority: 'normal', schedule: 'interval', frequency_minutes: 60, next_due: ago(DAY) },
  ];

  assert.deepEqual(sortSlowTasks(tasks).map((t) => t.name), ['soon', 'clock']);
});

// ---------------------------------------------------------------------------
// completion credits
// ---------------------------------------------------------------------------
test('completionNames reads every name off a completion, not just the first', () => {
  const completion = {
    slow_task_completion_drivers: [{ drivers: { name: 'Alex' } }, { drivers: { name: 'Jordan' } }],
  };

  assert.deepEqual(completionNames(completion), ['Alex', 'Jordan']);
});

test('completionNames survives a completion nobody was logged against', () => {
  assert.deepEqual(completionNames({}), []);
  assert.deepEqual(completionNames({ slow_task_completion_drivers: [{ drivers: null }] }), []);
});

test('startOfTodayIso is local midnight, not UTC midnight', () => {
  const iso = startOfTodayIso(new Date(2026, 8, 18, 20, 30));
  const back = new Date(iso);

  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 8);
  assert.equal(back.getDate(), 18);
  assert.equal(back.getHours(), 0);
  assert.equal(back.getMinutes(), 0);
});
