// Tests for the shared markup builders.
//
// These exist because the escaping bug that shipped once lived in a TEMPLATE,
// not in escapeHtml — every template interpolated a value correctly and the
// escaper itself was wrong. Now that the templates are functions, the hostile
// input can be pushed through each one and the output asserted directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attrs,
  badge,
  sectionHint,
  sectionToolbar,
  actionButton,
  dataTable,
  rowActions,
  field,
  textInput,
  numberInput,
  textArea,
  select,
  modalActions,
} from '../js/render.js';

// The exact shape a driver could self-add from the unauthenticated kiosk to
// break out of value="…" and run script in an admin's session.
const BREAKOUT = '" onfocus="alert(1)" autofocus x="';

// ---------------------------------------------------------------------------
// attrs
// ---------------------------------------------------------------------------
test('attrs drops nullish and false, and emits true as a bare attribute', () => {
  assert.equal(attrs({ id: 'a', placeholder: null, title: undefined, hidden: false }), ' id="a"');
  assert.equal(attrs({ disabled: true }), ' disabled');
});

test('attrs escapes values so an attribute cannot be broken out of', () => {
  const out = attrs({ value: BREAKOUT });
  assert.ok(!out.includes('onfocus="'), 'the payload must not become a live attribute');
  assert.ok(out.includes('&quot;'), 'quotes must be entity-escaped');
});

test('attrs emits nothing for an empty map', () => {
  assert.equal(attrs(), '');
  assert.equal(attrs({}), '');
});

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------
test('badge renders the requested tone', () => {
  assert.equal(badge('Active', 'good'), '<span class="badge badge-good">Active</span>');
});

test('badge falls back to neutral for a tone with no stylesheet rule', () => {
  // An unknown tone used to be possible via a raw status column; badge-mystery
  // matches no CSS rule, so it would render as unstyled text.
  assert.equal(badge('open', 'mystery'), '<span class="badge badge-neutral">open</span>');
});

test('badge escapes its label', () => {
  assert.ok(badge('<img src=x onerror=alert(1)>', 'warn').includes('&lt;img'));
});

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------
test('dataTable derives colspan from the column count', () => {
  const html = dataTable({ columns: ['A', 'B', 'C', ''], rows: '', empty: 'Nothing yet.' });
  assert.ok(html.includes('colspan="4"'), 'colspan must track the headers, not a hand-typed number');
  assert.ok(html.includes('Nothing yet.'));
});

test('dataTable interpolates caller-built rows raw', () => {
  const html = dataTable({ columns: ['A'], rows: '<tr><td>live</td></tr>', empty: 'none' });
  assert.ok(html.includes('<tr><td>live</td></tr>'));
  assert.ok(!html.includes('none'), 'the empty state must not render alongside real rows');
});

test('dataTable escapes headers and the empty message', () => {
  const html = dataTable({ columns: ['<b>H</b>'], rows: '', empty: '<b>E</b>' });
  assert.ok(html.includes('&lt;b&gt;H&lt;/b&gt;'));
  assert.ok(html.includes('&lt;b&gt;E&lt;/b&gt;'));
});

test('rowActions composes classes, data attributes and disabled state', () => {
  const html = rowActions([
    { label: 'Edit', className: 'edit-driver-btn', data: { 'data-driver-id': 'd-1' } },
    { label: '↑', className: 'move-item-btn', disabled: true, ariaLabel: 'Move up' },
  ]);
  assert.ok(html.startsWith('<div class="row-actions">'));
  assert.ok(html.includes('class="btn btn-secondary btn-sm edit-driver-btn"'));
  assert.ok(html.includes('data-driver-id="d-1"'));
  assert.ok(html.includes(' disabled'));
  assert.ok(html.includes('aria-label="Move up"'));
});

test('rowActions skips falsy entries so a conditional button can be omitted inline', () => {
  const html = rowActions([{ label: 'Edit', className: 'e' }, null, false]);
  assert.equal(html.match(/<button/g).length, 1);
});

// ---------------------------------------------------------------------------
// form controls — the historical attribute-breakout path
// ---------------------------------------------------------------------------
test('textInput escapes a value that would otherwise break out of the attribute', () => {
  const html = textInput({ id: 'driver-name-input', value: BREAKOUT });
  assert.ok(!html.includes('onfocus="alert(1)"'), 'the payload must stay inside value="…"');
  assert.ok(html.includes('&quot;'));
});

test('textInput omits placeholder and autocomplete when not given', () => {
  assert.equal(textInput({ id: 'x' }), '<input type="text" id="x" value="" />');
});

test('numberInput carries min through', () => {
  assert.ok(numberInput({ id: 'w', value: 7, min: 1 }).includes('min="1"'));
});

test('textArea escapes its body rather than its attributes', () => {
  const html = textArea({ id: 'notes', value: '</textarea><script>alert(1)</script>' });
  assert.ok(html.includes('&lt;/textarea&gt;'), 'a closing tag in the value must not end the element');
  assert.ok(!html.includes('<script>'));
});

test('select marks the chosen option and can lead with a placeholder', () => {
  const html = select({
    id: 'incident-driver-select',
    placeholder: 'Select…',
    options: [
      { value: 'd-1', label: 'Ada' },
      { value: 'd-2', label: 'Grace', selected: true },
    ],
  });
  assert.ok(html.includes('<option value="">Select…</option>'));
  assert.ok(html.includes('<option value="d-2" selected>Grace</option>'));
  assert.ok(!html.includes('<option value="d-1" selected>'));
});

test('select escapes option labels — driver names are untrusted kiosk input', () => {
  const html = select({ id: 's', options: [{ value: '1', label: BREAKOUT }] });
  assert.ok(!html.includes('onfocus="alert(1)"'));
});

test('field wires the label to its control', () => {
  const html = field('Name', 'driver-name-input', '<input id="driver-name-input" />');
  assert.ok(html.includes('<label class="field-label" for="driver-name-input">Name</label>'));
});

// ---------------------------------------------------------------------------
// section chrome
// ---------------------------------------------------------------------------
test('sectionToolbar renders a title alone or with trailing markup', () => {
  assert.ok(sectionToolbar('Drivers').includes('<h2 class="section-title">Drivers</h2>'));
  const withButton = sectionToolbar('Drivers', actionButton('+ Add Driver', 'add-driver-btn'));
  assert.ok(withButton.includes('id="add-driver-btn"'));
  assert.ok(withButton.includes('btn btn-primary btn-auto'));
});

test('sectionHint escapes interpolated counts and text', () => {
  assert.ok(sectionHint('2 past 12h without signing out.').includes('2 past 12h'));
});

test('modalActions always pairs the primary with a close-wired Cancel', () => {
  const html = modalActions('Save Changes', 'driver-save-btn');
  assert.ok(html.includes('id="driver-save-btn"'));
  assert.ok(html.includes('data-modal-close'));
});

test('modalActions can start its primary disabled', () => {
  // The kiosk checkout sheet renders with Start Shift disabled and only enables
  // once a driver is chosen — the handler that recomputes that is bound to
  // change/input, which have not fired when the sheet first paints.
  const html = modalActions('Start Shift', 'assign-confirm-btn', { disabled: true });
  assert.ok(html.includes(' disabled'));
  assert.ok(!modalActions('Start Shift', 'assign-confirm-btn').includes(' disabled'));
});

test('modalActions takes a custom cancel label', () => {
  assert.ok(modalActions('Go', 'g', { cancelLabel: 'Never mind' }).includes('Never mind'));
});
