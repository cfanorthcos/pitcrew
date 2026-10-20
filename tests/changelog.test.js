// The kiosk's Updates list. The badge count is the part that can go wrong
// quietly — a bad id or ordering lights up the whole history, or nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHANGELOG, unseenEntries } from '../js/changelog.js';

const entries = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];

test('unseenEntries is everything newer than the last one seen', () => {
  assert.deepEqual(unseenEntries(entries, 'b').map((e) => e.id), ['c']);
  assert.deepEqual(unseenEntries(entries, 'c'), []);
});

test('unseenEntries treats a device that has seen nothing as all new', () => {
  assert.equal(unseenEntries(entries, null).length, 3);
});

test('unseenEntries does not relight the history for an id that was removed', () => {
  assert.deepEqual(unseenEntries(entries, 'gone'), []);
});

test('changelog ids are unique and entries run newest first', () => {
  const ids = CHANGELOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const dates = CHANGELOG.map((e) => e.date);
  assert.deepEqual([...dates].sort().reverse(), dates);
  CHANGELOG.forEach((e) => {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.title && e.items.length, `${e.id} needs a title and items`);
  });
});
