// Pure markup builders shared by the kiosk and the admin dashboard.
//
// Every function here takes data and returns an HTML string. Nothing touches
// the DOM, reads globals, or has a side effect — which is the point: the
// templates were previously 500-odd lines of inline literals spread across 29
// render functions, so they could only be checked by loading the app and
// looking. As plain functions they get the same regression tests as everything
// else, and the escaping tests can finally cover the TEMPLATES rather than just
// escapeHtml in isolation (the stored-XSS bug lived in a template, not in the
// escaper).
//
// TRUST BOUNDARY, and it is the whole ballgame: parameters named `html` or
// `rows` are pre-built markup the caller assembled and are interpolated RAW.
// Everything else is treated as untrusted text and goes through escapeHtml
// here, so callers never have to remember. If you add a builder, keep that
// split — escape by default, and name any raw-HTML parameter so it is obvious
// at the call site that the caller owns the escaping.

import { escapeHtml } from './ui.js';

// ---------------------------------------------------------------------------
// attributes
// ---------------------------------------------------------------------------
// `{ 'data-driver-id': id }` -> ` data-driver-id="escaped"`. Nullish values
// drop the attribute entirely rather than emitting `="null"`, and `true` emits
// a bare boolean attribute (disabled, autofocus) the way HTML expects.
export function attrs(map = {}) {
  return Object.entries(map)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`))
    .join('');
}

// ---------------------------------------------------------------------------
// status badges
// ---------------------------------------------------------------------------
// tone is one of good | warn | bad | neutral | muted — the five that exist in
// css/admin.css. An unknown tone would silently render an unstyled badge, so
// fall back to neutral rather than emitting a class that matches no rule.
const BADGE_TONES = new Set(['good', 'warn', 'bad', 'neutral', 'muted']);

export function badge(label, tone = 'neutral') {
  const cls = BADGE_TONES.has(tone) ? tone : 'neutral';
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`;
}

// ---------------------------------------------------------------------------
// section chrome
// ---------------------------------------------------------------------------
export function sectionHint(text) {
  return `<p class="section-hint">${escapeHtml(text)}</p>`;
}

export function sectionWarning(text) {
  return `<p class="section-warning">${escapeHtml(text)}</p>`;
}

// `trailing` is raw markup — usually a button from actionButton() or a hint
// from sectionHint(), and sometimes nothing at all.
export function sectionToolbar(title, trailing = '') {
  return `
      <div class="section-toolbar">
        <h2 class="section-title">${escapeHtml(title)}</h2>
        ${trailing}
      </div>
    `;
}

// The "+ Add Driver" / "+ Add Hot Bag" button that sits in a section toolbar.
export function actionButton(label, id) {
  return `<button type="button" class="btn btn-primary btn-auto"${attrs({ id })}>${escapeHtml(label)}</button>`;
}

export function backLink(label, id) {
  return `<button type="button" class="back-link"${attrs({ id })}>${escapeHtml(label)}</button>`;
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------
// `columns` is an array of header labels (an empty string is a legitimate
// header for an actions column). `rows` is raw markup the caller built; `empty`
// is the message shown when it comes back blank.
//
// colspan is derived from columns.length instead of being typed by hand at
// every call site. Every one of the eleven tables happened to be correct, but
// the next column added to any of them would have silently broken its own empty
// state — the kind of bug nobody notices because the empty state is rare.
export function dataTable({ columns, rows, empty }) {
  const head = columns.map((label) => `<th>${escapeHtml(label)}</th>`).join('');
  const body = rows || `<tr><td colspan="${columns.length}">${escapeHtml(empty)}</td></tr>`;
  return `
      <div class="table-scroll">
        <table>
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
}

// The Edit / Deactivate / Resolve cluster at the end of an admin row.
// Each button: { label, className, data, disabled, ariaLabel }. `label` is
// escaped like everything else, so an entity such as &uarr; must be passed as
// the character itself ('↑'), not as markup.
export function rowActions(buttons) {
  const rendered = buttons
    .filter(Boolean)
    .map(({ label, className, data = {}, disabled = false, ariaLabel = null }) => {
      const classes = ['btn', 'btn-secondary', 'btn-sm', className].filter(Boolean).join(' ');
      return `<button type="button" class="${classes}"${attrs({
        ...data,
        disabled,
        'aria-label': ariaLabel,
      })}>${escapeHtml(label)}</button>`;
    })
    .join('');
  return `<div class="row-actions">${rendered}</div>`;
}

// ---------------------------------------------------------------------------
// form controls (modal bodies)
// ---------------------------------------------------------------------------
// `control` is raw markup from one of the builders below.
export function field(label, id, control) {
  return `
      <div>
        <label class="field-label"${attrs({ for: id })}>${escapeHtml(label)}</label>
        ${control}
      </div>
    `;
}

export function textInput({ id, value = '', placeholder = null, type = 'text', autocomplete = null }) {
  return `<input${attrs({ type, id, placeholder, autocomplete, value: String(value ?? '') })} />`;
}

export function numberInput({ id, value = '', min = null, placeholder = null }) {
  return `<input${attrs({ type: 'number', id, min, placeholder, value: String(value ?? '') })} />`;
}

// A native date picker, which on an iPad is the OS wheel rather than a text
// field somebody types a format into. `value` must already be YYYY-MM-DD —
// anything else renders blank, so callers convert from their timestamp first.
export function dateInput({ id, value = '', min = null }) {
  return `<input${attrs({ type: 'date', id, min, value: String(value ?? '') })} />`;
}

// A native colour well. The value must be a 6-digit hex — type="color" silently
// falls back to #000000 for shorthand (#fff), named colours or junk, so the
// caller normalises before rendering rather than watching a vehicle quietly
// turn black on save.
export function colorInput({ id, value = '#000000' }) {
  const hex = /^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value : '#000000';
  return `<input${attrs({ type: 'color', id, value: hex })} />`;
}

export function textArea({ id, value = '', placeholder = null }) {
  return `<textarea${attrs({ id, placeholder })}>${escapeHtml(value ?? '')}</textarea>`;
}

// `options` is [{ value, label, selected }]. A `placeholder` renders as a
// leading empty-valued option ("Select…"), which is how every select in the app
// signals "nothing chosen yet".
export function select({ id, options, placeholder = null }) {
  const head = placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : '';
  const body = options
    .map(
      ({ value, label, selected = false }) =>
        `<option${attrs({ value, selected })}>${escapeHtml(label)}</option>`,
    )
    .join('');
  return `<select${attrs({ id })}>${head}${body}</select>`;
}

// Every modal ends the same way: one primary action and a ghost Cancel wired to
// close by the data-modal-close hook in ui.js.
//
// `disabled` matters more than it looks: the kiosk's checkout modal opens with
// its confirm button disabled and only enables once a driver is chosen, and the
// handler that recomputes that state is bound to change/input events which have
// not fired yet when the sheet first renders. Drop the initial attribute and the
// button is live with nothing selected.
export function modalActions(primaryLabel, primaryId, { cancelLabel = 'Cancel', disabled = false } = {}) {
  return `
      <button type="button" class="btn btn-primary"${attrs({ id: primaryId, disabled })}>${escapeHtml(
        primaryLabel,
      )}</button>
      <button type="button" class="btn btn-ghost" data-modal-close>${escapeHtml(cancelLabel)}</button>
    `;
}
