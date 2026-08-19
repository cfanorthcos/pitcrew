// Regression tests for the write paths. Every case here corresponds to a bug
// found in the August 2026 code review — these exist so those specific
// failures can't come back silently.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDataApi } from '../js/data.js';
import { createFakeClient, byTable, pgError } from './fake-supabase.js';

function setup(handler) {
  const { client, calls } = createFakeClient(handler);
  return { api: createDataApi(client), calls };
}

const findFilter = (call, column) => call.filters.find((f) => f.column === column);

// ---------------------------------------------------------------------------
// returnVehicle — the checklist/session ordering bug
// ---------------------------------------------------------------------------
test('returnVehicle records the checklist before closing the session', async () => {
  const { api, calls } = setup(
    byTable({
      driving_session_checklist_items: { data: [] },
      driving_sessions: { data: [{ id: 'sess-1' }] },
    }),
  );

  await api.returnVehicle('sess-1', ['item-a', 'item-b'], 'all good');

  assert.deepEqual(
    calls.map((c) => c.table),
    ['driving_session_checklist_items', 'driving_sessions'],
    'checklist must be written first so a lost race never orphans rows',
  );
});

test('returnVehicle upserts checklist rows so a retry is not a unique violation', async () => {
  const { api, calls } = setup(
    byTable({
      driving_session_checklist_items: { data: [] },
      driving_sessions: { data: [{ id: 'sess-1' }] },
    }),
  );

  await api.returnVehicle('sess-1', ['item-a'], '');

  const checklist = calls[0];
  assert.equal(checklist.op, 'upsert');
  assert.equal(checklist.options.ignoreDuplicates, true);
  assert.equal(checklist.options.onConflict, 'session_id,item_id');
  assert.deepEqual(checklist.payload, [{ session_id: 'sess-1', item_id: 'item-a', checked: true }]);
});

test('returnVehicle guards the close on the session still being open', async () => {
  const { api, calls } = setup(
    byTable({
      driving_session_checklist_items: { data: [] },
      driving_sessions: { data: [{ id: 'sess-1' }] },
    }),
  );

  await api.returnVehicle('sess-1', ['item-a'], 'notes here');

  const close = calls[1];
  assert.equal(close.op, 'update');
  assert.equal(close.payload.checklist_completed, true);
  assert.equal(close.payload.return_notes, 'notes here');
  assert.ok(close.payload.end_time, 'end_time must be set');
  assert.deepEqual(findFilter(close, 'end_time'), { type: 'is', column: 'end_time', value: null });
});

test('returnVehicle throws when the shift was already closed by someone else', async () => {
  // A zero-row update is a PostgREST success. This is exactly the case that
  // used to show the driver "Vehicle returned" for a return that never happened.
  const { api } = setup(
    byTable({
      driving_session_checklist_items: { data: [] },
      driving_sessions: { data: [] },
    }),
  );

  await assert.rejects(() => api.returnVehicle('sess-1', ['item-a'], ''), /already signed out/i);
});

test('returnVehicle does not close the session if the checklist write fails', async () => {
  const { api, calls } = setup(
    byTable({
      driving_session_checklist_items: { error: pgError('42501', 'permission denied') },
      driving_sessions: { data: [{ id: 'sess-1' }] },
    }),
  );

  await assert.rejects(() => api.returnVehicle('sess-1', ['item-a'], ''));
  assert.deepEqual(calls.map((c) => c.table), ['driving_session_checklist_items']);
});

test('returnVehicle skips the checklist write when nothing was checked', async () => {
  const { api, calls } = setup(byTable({ driving_sessions: { data: [{ id: 'sess-1' }] } }));

  await api.returnVehicle('sess-1', [], '');

  assert.deepEqual(calls.map((c) => c.table), ['driving_sessions']);
});

// ---------------------------------------------------------------------------
// zero-row updates reported as success
// ---------------------------------------------------------------------------
test('markHotBagCleaned surfaces a missing RLS policy as a real error', async () => {
  // PGRST116 is what .single() returns when the update matched no rows.
  const { api } = setup(byTable({ hot_bags: { error: pgError('PGRST116') } }));

  await assert.rejects(() => api.markHotBagCleaned('bag-1'), /schema is up to date/i);
});

test('markHotBagCleaned sets last_cleaned and selects to prove a row matched', async () => {
  const { api, calls } = setup(byTable({ hot_bags: { data: { id: 'bag-1' } } }));

  await api.markHotBagCleaned('bag-1');

  const [call] = calls;
  assert.equal(call.op, 'update');
  assert.ok(call.payload.last_cleaned);
  assert.equal(call.single, true, 'must read a row back, or a no-op looks like success');
});

test('completeSlowTask logs the completion before advancing the task', async () => {
  const { api, calls } = setup(
    byTable({
      slow_task_completions: { data: [] },
      slow_tasks: { data: { id: 'task-1' } },
    }),
  );

  await api.completeSlowTask('task-1', 'driver-9', 'wiped everything down');

  assert.deepEqual(calls.map((c) => c.table), ['slow_task_completions', 'slow_tasks']);
  assert.equal(calls[0].payload.completed_by, 'driver-9');
  assert.equal(calls[0].payload.notes, 'wiped everything down');
  assert.ok(calls[1].payload.last_completed);
});

test('completeSlowTask stores a null driver rather than an empty string', async () => {
  const { api, calls } = setup(
    byTable({ slow_task_completions: { data: [] }, slow_tasks: { data: { id: 'task-1' } } }),
  );

  await api.completeSlowTask('task-1', null, '');

  assert.equal(calls[0].payload.completed_by, null);
  assert.equal(calls[0].payload.notes, null);
});

test('completeSlowTask does not advance the task if the completion write fails', async () => {
  const { api, calls } = setup(byTable({ slow_task_completions: { error: pgError('42501') } }));

  await assert.rejects(() => api.completeSlowTask('task-1', null, null));
  assert.deepEqual(calls.map((c) => c.table), ['slow_task_completions']);
});

// ---------------------------------------------------------------------------
// duplicate drivers
// ---------------------------------------------------------------------------
test('findDriverByName escapes ilike wildcards in the typed name', async () => {
  const { api, calls } = setup(byTable({ drivers: { data: [] } }));

  await api.findDriverByName('100%_Sam');

  assert.equal(findFilter(calls[0], 'name').value, '100\\%\\_Sam');
});

test('findDriverByName searches all drivers, not just active ones', async () => {
  // The whole point: a deactivated driver typing their name must be found,
  // otherwise they get a second row and their history splits.
  const { api, calls } = setup(byTable({ drivers: { data: [] } }));

  await api.findDriverByName('Sam');

  assert.equal(findFilter(calls[0], 'active'), undefined);
});

test('findDriverByName returns null when nobody matches', async () => {
  const { api } = setup(byTable({ drivers: { data: [] } }));
  assert.equal(await api.findDriverByName('Nobody'), null);
});

test('createDriver turns a unique violation into a readable message', async () => {
  const { api } = setup(byTable({ drivers: { error: pgError('23505') } }));

  await assert.rejects(() => api.createDriver('Sam'), /already exists/i);
});

test('createDriver stores a blank employee number as null', async () => {
  const { api, calls } = setup(byTable({ drivers: { data: { id: 'd-1' } } }));

  await api.createDriver('Sam', '');

  assert.equal(calls[0].payload.employee_number, null);
});

// ---------------------------------------------------------------------------
// checkout / force close
// ---------------------------------------------------------------------------
test('checkoutVehicle explains a lost race instead of leaking a Postgres code', async () => {
  const { api } = setup(byTable({ driving_sessions: { error: pgError('23505') } }));

  await assert.rejects(() => api.checkoutVehicle('driver-1', 'veh-1'), /just checked out by someone else/i);
});

test('forceCloseSession records a cleanup, not a normal return', async () => {
  const { api, calls } = setup(byTable({ driving_sessions: { data: [{ id: 'sess-1' }] } }));

  await api.forceCloseSession('sess-1', 'Closed by admin');

  const [call] = calls;
  assert.equal(
    call.payload.checklist_completed,
    false,
    'a force close must stay distinguishable from a real return',
  );
  assert.equal(call.payload.return_notes, 'Closed by admin');
  assert.deepEqual(findFilter(call, 'end_time'), { type: 'is', column: 'end_time', value: null });
});

test('forceCloseSession throws when the shift is already closed', async () => {
  const { api } = setup(byTable({ driving_sessions: { data: [] } }));

  await assert.rejects(() => api.forceCloseSession('sess-1', 'note'), /already closed/i);
});

// ---------------------------------------------------------------------------
// bounded history
// ---------------------------------------------------------------------------
test('fetchDriverHistory is bounded and newest-first', async () => {
  const { api, calls } = setup(byTable({ driving_sessions: { data: [] } }));

  await api.fetchDriverHistory();

  const limit = calls[0].modifiers.find((m) => m.type === 'limit');
  const order = calls[0].modifiers.find((m) => m.type === 'order');
  assert.equal(limit.count, 500);
  assert.equal(order.column, 'start_time');
  assert.equal(order.options.ascending, false);
});

test('fetchHotBagMaintenanceHistory accepts a caller-supplied bound', async () => {
  const { api, calls } = setup(byTable({ hot_bag_maintenance: { data: [] } }));

  await api.fetchHotBagMaintenanceHistory(25);

  assert.equal(calls[0].modifiers.find((m) => m.type === 'limit').count, 25);
});
