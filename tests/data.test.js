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

test('completeSlowTask logs the completion, then who did it, then advances the task', async () => {
  const { api, calls } = setup(
    byTable({
      slow_task_completions: { data: { id: 'c-1' } },
      slow_task_completion_drivers: { data: [] },
      slow_tasks: { data: { id: 'task-1' } },
    }),
  );

  await api.completeSlowTask('task-1', ['driver-9', 'driver-4'], 'wiped everything down');

  assert.deepEqual(calls.map((c) => c.table), [
    'slow_task_completions',
    'slow_task_completion_drivers',
    'slow_tasks',
  ]);
  assert.equal(calls[0].payload.notes, 'wiped everything down');
  assert.deepEqual(calls[1].payload, [
    { completion_id: 'c-1', driver_id: 'driver-9' },
    { completion_id: 'c-1', driver_id: 'driver-4' },
  ]);
  assert.ok(calls[2].payload.last_completed);
});

test('completeSlowTask credits everyone who worked on it, not just the first name', async () => {
  // A <select> could only ever record one person. Two drivers deep-cleaning the
  // bags together is the case this whole table exists for.
  const { api, calls } = setup(
    byTable({
      slow_task_completions: { data: { id: 'c-1' } },
      slow_task_completion_drivers: { data: [] },
      slow_tasks: { data: { id: 'task-1' } },
    }),
  );

  await api.completeSlowTask('task-1', ['a', 'b', 'c'], '');

  assert.equal(calls[1].payload.length, 3);
});

test('completeSlowTask drops blanks and duplicates from the driver list', async () => {
  const { api, calls } = setup(
    byTable({
      slow_task_completions: { data: { id: 'c-1' } },
      slow_task_completion_drivers: { data: [] },
      slow_tasks: { data: { id: 'task-1' } },
    }),
  );

  await api.completeSlowTask('task-1', ['a', null, 'a', '', 'b'], '');

  assert.deepEqual(calls[1].payload.map((r) => r.driver_id), ['a', 'b']);
});

test('completeSlowTask with nobody named skips the credit write entirely', async () => {
  // Logging who did it has always been optional, and an empty insert would be a
  // round trip that can only fail.
  const { api, calls } = setup(
    byTable({ slow_task_completions: { data: { id: 'c-1' } }, slow_tasks: { data: { id: 'task-1' } } }),
  );

  await api.completeSlowTask('task-1', [], '');

  assert.deepEqual(calls.map((c) => c.table), ['slow_task_completions', 'slow_tasks']);
  assert.equal(calls[0].payload.notes, null);
});

test('a failed credit write still advances the task, then reports itself', async () => {
  // The completion row is already written. Bailing out before last_completed
  // would leave the task reading as due and invite a second completion for work
  // that was done once — which for a times_per_day task burns a run off the day.
  const { api, calls } = setup(
    byTable({
      slow_task_completions: { data: { id: 'c-1' } },
      slow_task_completion_drivers: { error: pgError('42501') },
      slow_tasks: { data: { id: 'task-1' } },
    }),
  );

  await assert.rejects(() => api.completeSlowTask('task-1', ['a'], ''), /schema is up to date/i);

  assert.deepEqual(calls.map((c) => c.table), [
    'slow_task_completions',
    'slow_task_completion_drivers',
    'slow_tasks',
  ]);
  assert.ok(calls[2].payload.last_completed, 'the task must still advance');
});

test('completeSlowTask does not advance the task if the completion write fails', async () => {
  const { api, calls } = setup(byTable({ slow_task_completions: { error: pgError('42501') } }));

  await assert.rejects(() => api.completeSlowTask('task-1', [], null));
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
// return-checklist items
// ---------------------------------------------------------------------------
test('fetchChecklistItems returns only active items, in order', async () => {
  const { api, calls } = setup(byTable({ checklist_items: { data: [] } }));

  await api.fetchChecklistItems();

  assert.deepEqual(findFilter(calls[0], 'active'), { type: 'eq', column: 'active', value: true });
  assert.equal(calls[0].modifiers.find((m) => m.type === 'order').column, 'sort_order');
});

test('fetchAllChecklistItems includes retired items for the admin screen', async () => {
  const { api, calls } = setup(byTable({ checklist_items: { data: [] } }));

  await api.fetchAllChecklistItems();

  assert.equal(findFilter(calls[0], 'active'), undefined);
});

test('setChecklistItemActive retires rather than deletes', async () => {
  // History rows reference item_id, so a delete would orphan them.
  const { api, calls } = setup(byTable({ checklist_items: { data: { id: 'item-1' } } }));

  await api.setChecklistItemActive('item-1', false);

  assert.equal(calls[0].op, 'update');
  assert.equal(calls[0].payload.active, false);
});

test('setChecklistItemActive surfaces a missing write policy instead of silently passing', async () => {
  const { api } = setup(byTable({ checklist_items: { error: pgError('PGRST116') } }));

  await assert.rejects(() => api.setChecklistItemActive('item-1', false), /schema is up to date/i);
});

test('reorderChecklistItems renumbers sequentially from 1', async () => {
  // Renumbering rather than swapping: a swap silently no-ops when two rows
  // share a sort_order, and the order then drifts from what admin sees.
  const { api, calls } = setup(byTable({ checklist_items: { data: { id: 'x' } } }));

  await api.reorderChecklistItems(['c', 'a', 'b']);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => [findFilter(c, 'id').value, c.payload.sort_order]),
    [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ],
  );
});

test('reorderChecklistItems stops at the first failed write', async () => {
  let seen = 0;
  const { api, calls } = setup(() => {
    seen += 1;
    return seen === 2 ? { error: pgError('PGRST116') } : { data: { id: 'x' } };
  });

  await assert.rejects(() => api.reorderChecklistItems(['a', 'b', 'c']));
  assert.equal(calls.length, 2, 'must not keep writing after a failure');
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

test('setHotBagIssueStatus resolves an issue and stamps resolved_at', async () => {
  // The table shipped with a status column, a resolved_at column and a
  // dashboard counting open issues, but no way to ever close one — so every
  // reported issue stayed open forever.
  const { api, calls } = setup(byTable({ hot_bag_maintenance: { data: { id: 'm-1' } } }));

  await api.setHotBagIssueStatus('m-1', true);

  assert.equal(calls[0].table, 'hot_bag_maintenance');
  assert.equal(calls[0].op, 'update');
  assert.equal(calls[0].payload.status, 'resolved');
  assert.ok(calls[0].payload.resolved_at, 'resolved_at should be set');
  assert.equal(findFilter(calls[0], 'id').value, 'm-1');
});

test('setHotBagIssueStatus clears resolved_at when an issue is reopened', async () => {
  // A stale resolved_at on an open row would make the two columns disagree.
  const { api, calls } = setup(byTable({ hot_bag_maintenance: { data: { id: 'm-1' } } }));

  await api.setHotBagIssueStatus('m-1', false);

  assert.equal(calls[0].payload.status, 'open');
  assert.equal(calls[0].payload.resolved_at, null);
});

test('setHotBagIssueStatus surfaces a missing write policy instead of silently passing', async () => {
  // hot_bag_maintenance had select/insert but no update policy, so this
  // resolved to zero matched rows and PostgREST called it a success.
  const { api } = setup(byTable({ hot_bag_maintenance: { error: pgError('PGRST116') } }));

  await assert.rejects(() => api.setHotBagIssueStatus('m-1', true), /schema is up to date/i);
});

test('setHotBagIssueStatus never deletes the maintenance row', async () => {
  const { api, calls } = setup(byTable({ hot_bag_maintenance: { data: { id: 'm-1' } } }));

  await api.setHotBagIssueStatus('m-1', true);

  assert.ok(
    calls.every((c) => c.op !== 'delete'),
    'the maintenance log is history and must never be deleted',
  );
});

test('fetchHotBagMaintenanceHistory accepts a caller-supplied bound', async () => {
  const { api, calls } = setup(byTable({ hot_bag_maintenance: { data: [] } }));

  await api.fetchHotBagMaintenanceHistory(25);

  assert.equal(calls[0].modifiers.find((m) => m.type === 'limit').count, 25);
});

// ---------------------------------------------------------------------------
// bounded history, part two — and the counts that must NOT be derived from it
//
// Three history reads were still unbounded (incidents, vehicle detail, task
// completions), so they grew forever. Capping them exposed a second, quieter
// bug: the dashboard tiles and the per-row "open" columns counted by filtering
// those capped lists, so an open row older than the cap stopped being counted
// at all. Counting now reads the open rows directly.
// ---------------------------------------------------------------------------
test('fetchDriverIncidents is bounded and newest-first', async () => {
  const { api, calls } = setup(byTable({ driver_incidents: { data: [] } }));

  await api.fetchDriverIncidents();

  const limit = calls[0].modifiers.find((m) => m.type === 'limit');
  const order = calls[0].modifiers.find((m) => m.type === 'order');
  assert.equal(limit.count, 500);
  assert.equal(order.column, 'reported_at');
  assert.equal(order.options.ascending, false);
});

test('fetchVehicleHistory is bounded', async () => {
  const { api, calls } = setup(byTable({ driving_sessions: { data: [] } }));

  await api.fetchVehicleHistory('veh-1');

  assert.equal(calls[0].modifiers.find((m) => m.type === 'limit').count, 500);
  assert.equal(findFilter(calls[0], 'vehicle_id').value, 'veh-1');
});

test('fetchSlowTaskCompletions is bounded', async () => {
  const { api, calls } = setup(byTable({ slow_task_completions: { data: [] } }));

  await api.fetchSlowTaskCompletions('task-1');

  assert.equal(calls[0].modifiers.find((m) => m.type === 'limit').count, 500);
  assert.equal(findFilter(calls[0], 'task_id').value, 'task-1');
});

test('fetchOpenDriverIncidents filters on status rather than capping', async () => {
  // The count must stay correct when history outgrows HISTORY_PAGE_SIZE, so
  // this read is filtered, not truncated.
  const { api, calls } = setup(byTable({ driver_incidents: { data: [] } }));

  await api.fetchOpenDriverIncidents();

  assert.equal(findFilter(calls[0], 'status').value, 'open');
  assert.equal(
    calls[0].modifiers.find((m) => m.type === 'limit'),
    undefined,
    'a bound here would undercount open incidents',
  );
});

test('fetchOpenHotBagIssues filters on status rather than capping', async () => {
  const { api, calls } = setup(byTable({ hot_bag_maintenance: { data: [] } }));

  await api.fetchOpenHotBagIssues();

  assert.equal(findFilter(calls[0], 'status').value, 'open');
  assert.equal(
    calls[0].modifiers.find((m) => m.type === 'limit'),
    undefined,
    'a bound here would undercount open issues',
  );
});

test('the open-row reads select only what the counts need', async () => {
  // These run on the dashboard's first paint; there is no reason to pull the
  // full row (including free-text complaint details) just to count it.
  const { api, calls } = setup(
    byTable({ driver_incidents: { data: [] }, hot_bag_maintenance: { data: [] } }),
  );

  await api.fetchOpenDriverIncidents();
  await api.fetchOpenHotBagIssues();

  assert.equal(calls[0].columns, 'id, driver_id');
  assert.equal(calls[1].columns, 'id, bag_id');
});

// ---------------------------------------------------------------------------
// vehicles CRUD
//
// Vehicles were the last table with no client write path — taking a car off the
// road needed the Supabase SQL editor, which is the wrong tool for a Saturday.
// ---------------------------------------------------------------------------
test('fetchVehiclesWithAvailability hides retired vehicles from the kiosk by default', async () => {
  const { api, calls } = setup(byTable({ vehicles: { data: [] }, driving_sessions: { data: [] } }));

  await api.fetchVehiclesWithAvailability();

  const vehicleCall = calls.find((c) => c.table === 'vehicles');
  assert.equal(findFilter(vehicleCall, 'active').value, true);
});

test('fetchVehiclesWithAvailability includes retired vehicles for admin, active first', async () => {
  const { api, calls } = setup(byTable({ vehicles: { data: [] }, driving_sessions: { data: [] } }));

  await api.fetchVehiclesWithAvailability({ includeInactive: true });

  const vehicleCall = calls.find((c) => c.table === 'vehicles');
  assert.equal(findFilter(vehicleCall, 'active'), undefined, 'must not filter retired rows out');
  const orders = vehicleCall.modifiers.filter((m) => m.type === 'order');
  assert.equal(orders[0].column, 'active');
  assert.equal(orders[0].options.ascending, false);
  assert.equal(orders[1].column, 'name');
});

test('createVehicle writes the four columns the board reads', async () => {
  const { api, calls } = setup(byTable({ vehicles: { data: { id: 'v-1' } } }));

  await api.createVehicle({
    name: 'Green Car',
    color_name: 'Green',
    color_hex: '#2f8f4e',
    status: 'available',
  });

  assert.equal(calls[0].op, 'insert');
  assert.deepEqual(calls[0].payload, {
    name: 'Green Car',
    color_name: 'Green',
    color_hex: '#2f8f4e',
    status: 'available',
  });
});

test('createVehicle defaults a new vehicle to available', async () => {
  const { api, calls } = setup(byTable({ vehicles: { data: { id: 'v-1' } } }));

  await api.createVehicle({ name: 'Green Car', color_name: 'Green', color_hex: '#2f8f4e' });

  assert.equal(calls[0].payload.status, 'available');
});

test('setVehicleStatus is the one-tap off-road path and only touches status', async () => {
  const { api, calls } = setup(byTable({ vehicles: { data: { id: 'v-1' } } }));

  await api.setVehicleStatus('v-1', 'out_of_service');

  assert.equal(calls[0].op, 'update');
  assert.deepEqual(calls[0].payload, { status: 'out_of_service' });
  assert.equal(findFilter(calls[0], 'id').value, 'v-1');
});

test('setVehicleActive retires rather than deletes — sessions still point here', async () => {
  const { api, calls } = setup(byTable({ vehicles: { data: { id: 'v-1' } } }));

  await api.setVehicleActive('v-1', false);

  assert.deepEqual(calls[0].payload, { active: false });
  assert.ok(calls.every((c) => c.op !== 'delete'));
});

test('vehicle writes surface a missing RLS policy instead of silently passing', async () => {
  // vehicles had select-only policies until this feature existed, so a project
  // that has not run the migration would otherwise report a cheerful success
  // while changing nothing.
  const { api } = setup(byTable({ vehicles: { error: pgError('PGRST116') } }));

  await assert.rejects(() => api.setVehicleStatus('v-1', 'out_of_service'), /schema is up to date/i);
  await assert.rejects(() => api.setVehicleActive('v-1', false), /schema is up to date/i);
});

// ---------------------------------------------------------------------------
// vehicle maintenance reports
// ---------------------------------------------------------------------------
test('reportVehicleIssue files against the vehicle and normalises empty notes', async () => {
  const { api, calls } = setup(byTable({ vehicle_maintenance: { data: [] } }));

  await api.reportVehicleIssue('v-1', 'Warning light on', '');

  assert.equal(calls[0].table, 'vehicle_maintenance');
  assert.equal(calls[0].op, 'insert');
  assert.deepEqual(calls[0].payload, { vehicle_id: 'v-1', issue: 'Warning light on', notes: null });
});

test('fetchOpenVehicleIssues reads open rows directly rather than a capped history', async () => {
  // The same trap fetchOpenDriverIncidents exists to avoid: counting from the
  // capped log drifts low as resolved reports accumulate.
  const { api, calls } = setup(byTable({ vehicle_maintenance: { data: [] } }));

  await api.fetchOpenVehicleIssues();

  assert.equal(findFilter(calls[0], 'status').value, 'open');
  assert.ok(!calls[0].modifiers.some((m) => m.type === 'limit'), 'open issues must not be capped');
});

test('resolving a vehicle issue stamps resolved_at, reopening clears it', async () => {
  const { api, calls } = setup(byTable({ vehicle_maintenance: { data: { id: 'm-1' } } }));

  await api.setVehicleIssueStatus('m-1', true);
  assert.equal(calls[0].payload.status, 'resolved');
  assert.ok(calls[0].payload.resolved_at, 'a resolved report records when');

  await api.setVehicleIssueStatus('m-1', false);
  assert.equal(calls[1].payload.status, 'open');
  assert.equal(calls[1].payload.resolved_at, null, 'a reopened report must not keep a stale timestamp');
});

test('vehicle issue reports are never deleted — the maintenance log is history', async () => {
  const { api, calls } = setup(byTable({ vehicle_maintenance: { data: { id: 'm-1' } } }));

  await api.setVehicleIssueStatus('m-1', true);

  assert.ok(calls.every((c) => c.op !== 'delete'));
});

// ---------------------------------------------------------------------------
// slow tasks: repeating vs one-time, and priority
// ---------------------------------------------------------------------------
test('an interval task keeps its cadence and never has next_due written from the form', async () => {
  // next_due belongs to the slow_tasks_before_write trigger for an interval
  // task. Writing it here would fight the trigger on every save.
  const { api, calls } = setup(byTable({ slow_tasks: { data: { id: 't-1' } } }));

  await api.createSlowTask({
    name: 'Deep clean bags',
    description: '',
    schedule: 'interval',
    frequency_minutes: 43200,
    priority: 'high',
    next_due: '2026-10-01T12:00:00.000Z',
  });

  assert.deepEqual(calls[0].payload, {
    name: 'Deep clean bags',
    description: null,
    schedule: 'interval',
    frequency_minutes: 43200,
    due_times: null,
    times_per_day: null,
    priority: 'high',
  });
});

test('switching schedule clears the shape columns the old one owned', async () => {
  // A stale frequency_minutes on a row that is now times_of_day trips
  // slow_tasks_schedule_fields the moment somebody switches it back, and stale
  // due_times would quietly resurrect old slots.
  const { api, calls } = setup(byTable({ slow_tasks: { data: { id: 't-1' } } }));

  await api.updateSlowTask('t-1', {
    name: 'Walk the lot',
    schedule: 'times_of_day',
    frequency_minutes: 120,
    due_times: ['08:00', '13:00'],
    times_per_day: 4,
    priority: 'normal',
  });

  assert.equal(calls[0].op, 'update');
  assert.equal(calls[0].payload.frequency_minutes, null);
  assert.equal(calls[0].payload.times_per_day, null);
  assert.deepEqual(calls[0].payload.due_times, ['08:00', '13:00']);
});

test('a times_per_day task stores its target and nothing else', async () => {
  const { api, calls } = setup(byTable({ slow_tasks: { data: { id: 't-1' } } }));

  await api.createSlowTask({
    name: 'Wipe the counter',
    schedule: 'times_per_day',
    times_per_day: 3,
    frequency_minutes: 60,
    due_times: ['08:00'],
  });

  assert.equal(calls[0].payload.times_per_day, 3);
  assert.equal(calls[0].payload.frequency_minutes, null);
  assert.equal(calls[0].payload.due_times, null);
});

test('a one-time task carries a due date and drops every cadence column', async () => {
  const { api, calls } = setup(byTable({ slow_tasks: { data: { id: 't-1' } } }));

  await api.updateSlowTask('t-1', {
    name: 'Swap the floor mats',
    description: 'One-off',
    schedule: 'once',
    frequency_minutes: 43200,
    priority: 'low',
    next_due: '2026-10-01T12:00:00.000Z',
  });

  assert.equal(calls[0].payload.schedule, 'once');
  assert.equal(calls[0].payload.frequency_minutes, null);
  assert.equal(calls[0].payload.next_due, '2026-10-01T12:00:00.000Z');
});

test('editing a one-time task without touching the date leaves next_due alone', async () => {
  const { api, calls } = setup(byTable({ slow_tasks: { data: { id: 't-1' } } }));

  await api.updateSlowTask('t-1', {
    name: 'Swap the floor mats',
    schedule: 'once',
    priority: 'normal',
    next_due: null,
  });

  assert.ok(!('next_due' in calls[0].payload), 'a blank date must not clear the stored due date');
});

test('a task saved with no schedule or priority still gets both', async () => {
  const { api, calls } = setup(byTable({ slow_tasks: { data: { id: 't-1' } } }));

  await api.createSlowTask({ name: 'Inspect equipment', frequency_minutes: 20160 });

  assert.equal(calls[0].payload.schedule, 'interval');
  assert.equal(calls[0].payload.priority, 'normal');
});

test('completeSlowTask stamps last_completed and lets the trigger own next_due', async () => {
  const { api, calls } = setup(
    byTable({ slow_task_completions: { data: { id: 'c-1' } }, slow_tasks: { data: { id: 't-1' } } }),
  );

  await api.completeSlowTask('t-1', [], 'done');

  assert.deepEqual(calls.map((c) => c.table), ['slow_task_completions', 'slow_tasks']);
  assert.deepEqual(Object.keys(calls[1].payload), ['last_completed']);
});

test('completion history reads the names through the join table', async () => {
  const { api, calls } = setup(byTable({ slow_task_completions: { data: [] } }));

  await api.fetchSlowTaskCompletions('t-1');

  assert.match(calls[0].columns, /slow_task_completion_drivers\(drivers\(name\)\)/);
});

test("today's completion counts are tallied per task from one bounded read", async () => {
  const { api, calls } = setup(
    byTable({
      slow_task_completions: {
        data: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'a' }],
      },
    }),
  );

  const counts = await api.fetchSlowTaskCompletionCounts('2026-09-18T06:00:00.000Z');

  assert.equal(findFilter(calls[0], 'completed_at').type, 'gte');
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.get('b'), 1);
  assert.equal(counts.get('missing'), undefined);
});
