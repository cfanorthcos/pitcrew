// Markup builders for the kiosk's own component vocabulary.
//
// Separate from js/render.js on purpose. That module holds the builders the
// ADMIN dashboard is made of — tables, row-action clusters, the badge styles in
// css/admin.css. The kiosk has its own stylesheet and its own components
// (tinted pills, icon tiles, inset grouped rows), and folding both into one
// module would mean every call site has to know which of two design systems a
// given function belongs to.
//
// Same trust boundary as render.js: parameters named `html` are caller-built
// markup and interpolated raw; everything else is escaped here.

import { escapeHtml } from './ui.js';
import { attrs } from './render.js';
import { icon } from './icons.js';
import { initials } from './match.js';

// ---------------------------------------------------------------------------
// status pills — soft tinted background, darkened ink. Never the raw iOS system
// colour as text: #34c759 on white is about 2:1 and unreadable at six feet.
// ---------------------------------------------------------------------------
const PILL_TONES = new Set(['good', 'warn', 'info', 'muted']);

export function pill(label, tone = 'muted', iconHtml = '') {
  const cls = PILL_TONES.has(tone) ? tone : 'muted';
  return `<span class="pill pill-${cls}">${iconHtml}${escapeHtml(label)}</span>`;
}

// ---------------------------------------------------------------------------
// the rounded-square glyph tile at the top of each card
// ---------------------------------------------------------------------------
export function iconTile(glyphHtml, { background = 'var(--fill)', color = null } = {}) {
  const style = `background:${background}${color ? `;color:${color}` : ''}`;
  return `<span class="icon-tile" style="${escapeHtml(style)}">${glyphHtml}</span>`;
}

// ---------------------------------------------------------------------------
// grouped list rows
// ---------------------------------------------------------------------------
export function avatar(name, variant = '') {
  const cls = variant ? ` is-${variant}` : '';
  return `<span class="avatar${cls}">${escapeHtml(initials(name))}</span>`;
}

// `leadingHtml` and `trailingHtml` are raw. A row is a <button> so the whole
// 88px strip is the hit target rather than the text inside it.
export function listRow({ leadingHtml = '', title, sub = null, trailingHtml = '', data = {}, strong = false }) {
  return `
    <button type="button" class="row"${attrs(data)}>
      ${leadingHtml}
      <span class="row-body">
        <span class="row-title${strong ? ' is-strong' : ''}">${escapeHtml(title)}</span>
        ${sub ? `<span class="row-sub">${escapeHtml(sub)}</span>` : ''}
      </span>
      ${trailingHtml}
    </button>
  `;
}

export function chevron() {
  return `<span class="row-chevron">${icon.chevron(22)}</span>`;
}

// ---------------------------------------------------------------------------
// return checklist row — Reminders-style circle, whole row tappable
// ---------------------------------------------------------------------------
export function checkRow({ id, label, checked = false }) {
  return `
    <button type="button" class="check" role="checkbox" aria-checked="${checked ? 'true' : 'false'}"${attrs({
      'data-item-id': id,
    })}>
      <span class="check-mark">${icon.check(24, '#fff')}</span>
      <span class="check-label">${escapeHtml(label)}</span>
    </button>
  `;
}

// ---------------------------------------------------------------------------
// section chrome
// ---------------------------------------------------------------------------
export function groupHead(text) {
  return `<span class="group-head">${escapeHtml(text)}</span>`;
}

export function groupFoot(text) {
  return `<span class="group-foot">${escapeHtml(text)}</span>`;
}

export function emptyState(text) {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

// ---------------------------------------------------------------------------
// buttons
// ---------------------------------------------------------------------------
export function button(label, { variant = 'fill', data = {}, disabled = false, iconHtml = '' } = {}) {
  return `<button type="button" class="btn btn-${escapeHtml(variant)}"${attrs({
    ...data,
    disabled,
  })}>${iconHtml}${escapeHtml(label)}</button>`;
}
