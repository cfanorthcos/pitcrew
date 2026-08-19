// Shared UI helpers used by both the driver kiosk (app.js) and the admin
// dashboard (admin.js). These were previously duplicated verbatim in both
// files, which is how the escaping bug below survived in two places at once.

import { HOT_BAG_CLEAN_WINDOW_DAYS } from './config.js';

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

export function frequencyLabel(days) {
  if (days === 1) return 'Daily';
  if (days === 7) return 'Weekly';
  if (days === 14) return 'Every 2 weeks';
  if (days === 30) return 'Monthly';
  return `Every ${days} days`;
}

export function isNeedsCleaning(bag) {
  if (!bag.last_cleaned) return true;
  const elapsedMs = Date.now() - new Date(bag.last_cleaned).getTime();
  const windowDays = bag.clean_window_days ?? HOT_BAG_CLEAN_WINDOW_DAYS;
  return elapsedMs > windowDays * 24 * 60 * 60 * 1000;
}

export function isTaskDue(task) {
  return new Date(task.next_due) <= new Date();
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
