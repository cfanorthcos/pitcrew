// The kiosk's Updates button: a red count of changes this iPad hasn't seen yet,
// and a sheet listing the recent history from js/changelog.js.
//
// "Seen" is remembered in localStorage on this device only. That's a
// convenience, not a record — a private window or cleared site data just shows
// the badge again, which is harmless, so every storage touch is wrapped.

import { CHANGELOG, unseenEntries } from './changelog.js';
import { escapeHtml, formatCloseDate, openModal } from './ui.js';

const STORAGE_KEY = 'pitcrew.updates.lastSeen';

function readLastSeen() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage blocked: the badge just comes back next load.
  }
}

function renderBadge(button) {
  const count = unseenEntries(CHANGELOG, readLastSeen()).length;
  const badge = button.querySelector('.k-updates-badge');
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.classList.toggle('hidden', count === 0);
  button.setAttribute('aria-label', count ? `Updates, ${count} new` : 'Updates');
}

function openUpdatesModal(button) {
  const unseen = new Set(unseenEntries(CHANGELOG, readLastSeen()).map((e) => e.id));
  const entries = CHANGELOG.map(
    (entry) => `
      <li class="update-entry">
        <div class="update-head">
          <span class="update-date">${escapeHtml(formatCloseDate(entry.date))}</span>
          ${unseen.has(entry.id) ? '<span class="update-new">New</span>' : ''}
        </div>
        <h3 class="update-title">${escapeHtml(entry.title)}</h3>
        <ul class="update-items">
          ${entry.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </li>
    `,
  ).join('');

  const sheet = openModal(
    'Recent updates',
    `
      <h2>What’s New</h2>
      <p class="meta">Recent changes to PitCrew.</p>
      <ul class="update-list">${entries}</ul>
      <button type="button" class="btn btn-primary" data-modal-close>Got it</button>
    `,
  );

  // openModal focuses the first button, which is "Got it" at the very bottom,
  // and the browser scrolls it into view. Start at the newest entry instead.
  sheet.scrollTop = 0;

  if (CHANGELOG.length) writeLastSeen(CHANGELOG[0].id);
  renderBadge(button);
}

export function initUpdates(button) {
  if (!button || CHANGELOG.length === 0) return;
  button.classList.remove('hidden');
  renderBadge(button);
  button.addEventListener('click', () => openUpdatesModal(button));
}
