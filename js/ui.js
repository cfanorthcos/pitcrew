// Shared UI helpers used by both the driver kiosk (app.js) and the admin
// dashboard (admin.js). These were previously duplicated verbatim in both
// files, which is how the escaping bug below survived in two places at once.

import { HOT_BAG_CLEAN_WINDOW_DAYS, SHIFT_OVERDUE_HOURS } from './config.js';
import {
  SLOW_TASK_PRIORITIES,
  DEFAULT_SLOW_TASK_PRIORITY,
  DEFAULT_SLOW_TASK_SCHEDULE,
} from './data.js';

// ---------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------
// The old implementation round-tripped through textContent -> innerHTML, which
// escapes &, < and > but NOT quotes. Every `attr="${escapeHtml(value)}"` in the
// templates was therefore an attribute breakout: a driver self-adding the name
//     " onfocus="…" autofocus x="
// from the unauthenticated kiosk got that markup executed in an admin's browser
// the next time the Drivers table or the edit modal rendered. Escape quotes too.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Colours come from the vehicles table, which has no client write policy — but
// escaping alone wouldn't stop `red;background-image:url(...)` inside a style
// attribute, so validate the shape rather than trusting it.
export function safeHex(value, fallback = '#b9b3a7') {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value ?? '')) ? value : fallback;
}

// Which ink stays readable on a given background.
//
// Vehicle colours are operator-chosen and cover the whole range: the kiosk
// paints a car glyph onto a tile filled with the vehicle's own colour, and
// hard-coding white meant "White Car" (#e8e6e1) rendered a white glyph on a
// near-white tile — invisible on the wall. Relative luminance per WCAG, with
// the usual 0.5-ish split.
export function inkOn(hex, dark = '#1c1a16', light = '#ffffff') {
  const raw = String(hex ?? '').replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return light;

  const channel = (start) => {
    const v = parseInt(full.slice(start, start + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? dark : light;
}

// ---------------------------------------------------------------------------
// time formatting
// ---------------------------------------------------------------------------
export function formatTime(iso, fallback = '—') {
  if (!iso) return fallback;
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(iso, fallback = '—') {
  if (!iso) return fallback;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso, fallback = '—') {
  if (!iso) return fallback;
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// "3d 04h" / "1h 22m" / "14m" — the live shift counters on the vehicle board.
export function formatElapsed(iso) {
  if (!iso) return '—';
  const totalMinutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

// Scans faster than a date on a wall-mounted board: "yesterday", "9 days ago".
export function formatRelativeDays(iso, fallback = 'never') {
  if (!iso) return fallback;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

// "Every 2 hours" / "Monthly" / "Every 45 minutes". Named cadences win where
// one exists, because "Daily" reads faster on a wall than "Every 1440 minutes".
export function intervalLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return 'No cadence set';
  const NAMED = {
    60: 'Hourly',
    1440: 'Daily',
    10080: 'Weekly',
    20160: 'Every 2 weeks',
    43200: 'Monthly',
  };
  if (NAMED[minutes]) return NAMED[minutes];
  if (minutes % 10080 === 0) return `Every ${minutes / 10080} weeks`;
  if (minutes % 1440 === 0) return `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

// Kept because cadences used to be stored in days and the admin form still
// offers days as a unit; everything downstream works in minutes.
// formatRelativeDays collapses everything inside a day to "today", which is
// useless for a task that comes round every two hours — "last done today" is
// the one thing the person standing there already knows. This keeps the same
// voice and just resolves finer at the near end.
export function formatRelativeTime(iso, fallback = 'never') {
  if (!iso) return fallback;
  const elapsedMs = Date.now() - new Date(iso).getTime();
  if (elapsedMs < 0) return 'just now';
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatRelativeDays(iso, fallback);
}

export function frequencyLabel(days) {
  return intervalLabel(days * 1440);
}

export function isNeedsCleaning(bag) {
  if (!bag.last_cleaned) return true;
  const elapsedMs = Date.now() - new Date(bag.last_cleaned).getTime();
  const windowDays = bag.clean_window_days ?? HOT_BAG_CLEAN_WINDOW_DAYS;
  return elapsedMs > windowDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// slow task schedules
//
// Four shapes (see sql/schema.sql), and everything the boards need to know
// about a task comes out of taskStatus() below rather than being re-derived at
// each call site. The two clock-based schedules are resolved against LOCAL
// time on purpose: "the 8am walk" means 8am in the building, and the kiosk's
// clock is the clock in the building.
// ---------------------------------------------------------------------------

// Rows written before a migration are missing the column that replaced what
// they do have. Normalising here rather than at each call site is what lets the
// app be deployed before the SQL is run without every board reading wrong.
export function taskSchedule(task) {
  if (task.schedule) return task.schedule;
  if (task.repeats === false) return 'once';
  return DEFAULT_SLOW_TASK_SCHEDULE;
}

export function taskIntervalMinutes(task) {
  if (Number.isFinite(task.frequency_minutes)) return task.frequency_minutes;
  if (Number.isFinite(task.frequency_days)) return task.frequency_days * 1440;
  return null;
}

// Postgres hands back a `time` as "08:00:00" (sometimes with a fractional
// part). Anything unparseable is dropped rather than rendered as NaN:NaN.
export function parseClockTime(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function taskDueTimes(task) {
  return (task.due_times ?? [])
    .map(parseClockTime)
    .filter((m) => m !== null)
    .sort((a, b) => a - b);
}

// The "HH:MM" an <input type="time"> round-trips. formatClockTime is for
// reading; this is for editing, and the two must not be confused — a localised
// "1:00 PM" put back into a time input renders blank.
export function clockValue(minutesOfDay) {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatClockTime(minutesOfDay) {
  const d = new Date(2000, 0, 1, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function startOfLocalDay(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Midnight in the building, as an instant the database can filter on. The
// times_per_day tally resets on the kiosk's own calendar day, not on UTC's —
// a store open past 5pm Mountain would otherwise roll its counter over in the
// middle of the evening.
export function startOfTodayIso(now = new Date()) {
  return startOfLocalDay(now).toISOString();
}

// The slot a times_of_day task is currently answering: the most recent one that
// has come round, which before the first slot of the day is yesterday's last.
// Without the wrap-around, an 18:00-only task reads "not due" all night, which
// is exactly when somebody is looking at the board wondering if it got done.
function currentSlot(times, now) {
  if (times.length === 0) return null;
  const midnight = startOfLocalDay(now);
  const minutesNow = (now.getTime() - midnight.getTime()) / 60000;
  const passed = times.filter((t) => t <= minutesNow);
  if (passed.length > 0) return new Date(midnight.getTime() + passed[passed.length - 1] * 60000);
  return new Date(midnight.getTime() + (times[times.length - 1] - 1440) * 60000);
}

function nextSlot(times, now) {
  if (times.length === 0) return null;
  const midnight = startOfLocalDay(now);
  const minutesNow = (now.getTime() - midnight.getTime()) / 60000;
  const upcoming = times.find((t) => t > minutesNow);
  if (upcoming !== undefined) return new Date(midnight.getTime() + upcoming * 60000);
  return new Date(midnight.getTime() + (times[0] + 1440) * 60000);
}

// Everything both boards need about one task, in one place.
//
//   due       should it be on the "Due now" list
//   finished  a one-off that has been done; it never comes back
//   doneToday how many runs are logged today, for a times_per_day task
//   target    how many runs that task wants
//   nextAt    when it next comes round, or null if there is nothing to show
//
// `doneToday` is passed in rather than read here because it costs a query, and
// only one of the four schedules needs it. Defaulting to 0 means a board that
// could not load the counts shows the task as still needing doing — the safe
// direction to be wrong in.
export function taskStatus(task, { doneToday = 0, now = new Date() } = {}) {
  const schedule = taskSchedule(task);
  const lastCompleted = task.last_completed ? new Date(task.last_completed) : null;

  if (schedule === 'once') {
    const finished = Boolean(lastCompleted);
    const nextAt = task.next_due ? new Date(task.next_due) : null;
    return { schedule, finished, due: !finished && nextAt !== null && nextAt <= now, nextAt };
  }

  if (schedule === 'times_of_day') {
    const times = taskDueTimes(task);
    const slot = currentSlot(times, now);
    const due = slot !== null && (lastCompleted === null || lastCompleted < slot);
    return { schedule, finished: false, due, slotAt: slot, nextAt: due ? slot : nextSlot(times, now) };
  }

  if (schedule === 'times_per_day') {
    const target = Number.isFinite(task.times_per_day) ? task.times_per_day : 1;
    return {
      schedule,
      finished: false,
      due: doneToday < target,
      doneToday,
      target,
      // Nothing left today: it comes back at midnight, and saying so beats a
      // blank cell on a board somebody is scanning for what is left.
      nextAt: doneToday < target ? now : new Date(startOfLocalDay(now).getTime() + 86400000),
    };
  }

  const nextAt = task.next_due ? new Date(task.next_due) : null;
  return { schedule, finished: false, due: nextAt === null || nextAt <= now, nextAt };
}

// "in 40 min" / "in 3 hours" / "tomorrow" / "in 9 days". Resolves finer than a
// day at the near end because a task can now come round twice before lunch.
//
// Past a day it counts CALENDAR days, not 24-hour blocks: 28 hours away is
// "tomorrow" if it lands tomorrow and "in 2 days" if it lands the day after,
// and which one it is depends on the time of day, not on the arithmetic.
export function untilLabel(date, now = new Date()) {
  if (!date) return null;
  const ms = date.getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(
    (startOfLocalDay(date).getTime() - startOfLocalDay(now).getTime()) / 86400000,
  );
  return days <= 1 ? 'tomorrow' : `in ${days} days`;
}

// The names on a completion, through the join table. Empty is a real answer —
// logging who did it has always been optional.
export function completionNames(completion) {
  return (completion.slow_task_completion_drivers ?? [])
    .map((row) => row.drivers?.name)
    .filter(Boolean);
}

export function isTaskFinished(task) {
  return taskStatus(task).finished;
}

export function isTaskDue(task, options) {
  return taskStatus(task, options).due;
}

// "Every 2 hours" / "At 8:00 AM, 1:00 PM, 6:00 PM" / "3x per day" / "One-time"
// — one slot on the card whatever the schedule, because it answers the same
// question: how often does this come round?
export function scheduleLabel(task) {
  const schedule = taskSchedule(task);
  if (schedule === 'once') return 'One-time';
  if (schedule === 'times_per_day') {
    const n = Number.isFinite(task.times_per_day) ? task.times_per_day : 1;
    return `${n}\u00d7 per day`;
  }
  if (schedule === 'times_of_day') {
    const times = taskDueTimes(task);
    if (times.length === 0) return 'No times set';
    return `At ${times.map(formatClockTime).join(', ')}`;
  }
  return intervalLabel(taskIntervalMinutes(task));
}

// ---------------------------------------------------------------------------
// slow task priority
// ---------------------------------------------------------------------------
const PRIORITY_BY_VALUE = new Map(SLOW_TASK_PRIORITIES.map((p) => [p.value, p]));

// Unknown or missing values fall back to normal rather than sorting off the end
// of the list: a task saved before the priority column existed still has to land
// somewhere sensible among the ones that do.
function priorityMeta(value) {
  return PRIORITY_BY_VALUE.get(value) ?? PRIORITY_BY_VALUE.get(DEFAULT_SLOW_TASK_PRIORITY);
}

export function priorityLabel(value) {
  return priorityMeta(value).label;
}

export function priorityRank(value) {
  return priorityMeta(value).rank;
}

// Highest priority first, then soonest due. Priority is the tiebreak that
// matters when several tasks are due at once and there is time for one of them;
// it deliberately does not change WHEN something is due, only what gets picked
// off the list first.
// A clock-based task stores no next_due, so fall back to the instant its
// schedule says it next comes round. Sorting on a raw null would park every
// times_of_day task at the epoch and float it above everything else.
function taskSortInstant(task) {
  const status = taskStatus(task);
  if (status.nextAt) return status.nextAt.getTime();
  return task.next_due ? new Date(task.next_due).getTime() : Number.MAX_SAFE_INTEGER;
}

export function compareSlowTasks(a, b) {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  return taskSortInstant(a) - taskSortInstant(b);
}

export function sortSlowTasks(tasks) {
  return [...tasks].sort(compareSlowTasks);
}

// A shift open past SHIFT_OVERDUE_HOURS almost certainly means the driver went
// home without signing out. Both boards flag it; neither acts on it.
export function isShiftOverdue(startTime, now = Date.now()) {
  if (!startTime) return false;
  return now - new Date(startTime).getTime() > SHIFT_OVERDUE_HOURS * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// banners / toasts
// ---------------------------------------------------------------------------
const BANNER_MS = { error: 6000, success: 4500 };

function showBanner(kind, message) {
  const region = document.getElementById('banner-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `banner banner-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  el.addEventListener('click', () => el.remove());
  region.appendChild(el);
  setTimeout(() => el.remove(), BANNER_MS[kind]);
}

export function showError(message) {
  showBanner('error', message);
}

export function showSuccess(message) {
  showBanner('success', message);
}

function updateOfflineBanner() {
  const region = document.getElementById('banner-region');
  if (!region) return;
  const existing = document.getElementById('offline-banner');
  if (navigator.onLine) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'offline-banner';
  el.className = 'banner banner-offline';
  el.setAttribute('role', 'status');
  el.textContent = 'No internet connection — retrying…';
  region.prepend(el);
}

export function initOfflineBanner() {
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  updateOfflineBanner();
}

// ---------------------------------------------------------------------------
// modal sheet
// ---------------------------------------------------------------------------
let restoreFocusTo = null;

function onModalKeydown(event) {
  if (event.key === 'Escape') closeModal();
}

export function isModalOpen() {
  return Boolean(document.getElementById('modal-region')?.firstElementChild);
}

export function closeModal() {
  const region = document.getElementById('modal-region');
  if (!region || !region.firstElementChild) return;
  region.innerHTML = '';
  document.removeEventListener('keydown', onModalKeydown);
  if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
  restoreFocusTo = null;
}

// Renders `innerHtml` inside a dismissible sheet and hands back the sheet so
// callers can query their own fields out of it. Centralises what every modal
// needed and none of them had: Escape to close, tap-outside to close, a
// labelled dialog role, and focus that lands in the sheet and comes back after.
// Any element marked `data-modal-close` is wired to dismiss automatically.
export function openModal(label, innerHtml) {
  const region = document.getElementById('modal-region');
  restoreFocusTo = document.activeElement;
  region.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
        ${innerHtml}
      </div>
    </div>
  `;

  const overlay = region.querySelector('.modal-overlay');
  const sheet = region.querySelector('.modal-sheet');
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeModal();
  });
  sheet.querySelectorAll('[data-modal-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', onModalKeydown);
  sheet.querySelector('input, select, textarea, button')?.focus();
  return sheet;
}

// ---------------------------------------------------------------------------
// live ticker — refreshes every [data-since] counter and [data-clock] readout
// in place, so the board's shift timers run without refetching the board.
// ---------------------------------------------------------------------------
const TICK_MS = 15000;

// Also call this straight after rendering anything containing [data-since],
// otherwise freshly-built counters sit on their placeholder for up to a full
// tick before the interval catches them.
export function refreshTickers() {
  document.querySelectorAll('[data-since]').forEach((el) => {
    el.textContent = formatElapsed(el.dataset.since);
  });
  document.querySelectorAll('[data-clock]').forEach((el) => {
    el.textContent = formatTime(new Date().toISOString());
  });
}

export function startTicker() {
  refreshTickers();
  setInterval(refreshTickers, TICK_MS);
}
