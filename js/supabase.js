// Thin data-access layer shared by app.js (driver kiosk) and admin.js.
// No mileage fields exist anywhere in this file, on purpose.

// Pinned to an exact version on purpose. `@2` resolves to whatever esm.sh
// considers newest at page load, so an upstream release could break the kiosk
// mid-shift with no deploy on our side. Bump this deliberately and test.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// The admin history screens used to select every row ever written with no
// bound, so they got slower and heavier every week the app ran. They're
// newest-first, and nobody scrolls past a few hundred rows on an iPad, so cap
// the fetch and let the UI say when it's truncated.
export const HISTORY_PAGE_SIZE = 500;

// A plain `.update().eq('id', id)` with no matching RLS update policy
// doesn't error — Postgres just matches zero rows and PostgREST reports
// success. Admin edit/deactivate actions route through this so a missing
// policy (e.g. a schema migration that hasn't been run yet) surfaces as a
// visible error instead of silently doing nothing.
async function updateRowOrThrow(table, id, patch) {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).select('id').single();
  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error("That change didn't save — check that the database schema is up to date.");
    }
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------------
// drivers / vehicles (reference data — edited via SQL, see README)
// ---------------------------------------------------------------------------
export async function fetchActiveDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('active', true)
    .order('name');
  if (error) throw error;
  return data;
}

// 23505 here is the drivers_name_unique index (case-insensitive on name).
const DUPLICATE_DRIVER_MESSAGE = 'A driver with that name already exists.';

export async function createDriver(name, employeeNumber = null) {
  const { data, error } = await supabase
    .from('drivers')
    .insert({ name, employee_number: employeeNumber || null })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error(DUPLICATE_DRIVER_MESSAGE);
    throw error;
  }
  return data;
}

// Case-insensitive exact-name lookup across ALL drivers, active or not. The
// kiosk's "not listed — type my name" path used to dedupe against the active
// dropdown only, so a deactivated driver typing their own name silently
// created a second driver row and split their history in two.
export async function findDriverByName(name) {
  // ilike treats % and _ as wildcards; a name containing either would match
  // the wrong row, so escape them (backslash is Postgres's default escape).
  const pattern = String(name).replace(/[\\%_]/g, '\\$&');
  const { data, error } = await supabase.from('drivers').select('*').ilike('name', pattern).limit(1);
  if (error) throw error;
  return data[0] ?? null;
}

// ---------------------------------------------------------------------------
// admin: drivers CRUD
// ---------------------------------------------------------------------------
export async function fetchAllDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .order('active', { ascending: false })
    .order('name');
  if (error) throw error;
  return data;
}

export async function updateDriver(id, { name, employee_number }) {
  try {
    await updateRowOrThrow('drivers', id, { name, employee_number: employee_number || null });
  } catch (err) {
    if (err.code === '23505') throw new Error(DUPLICATE_DRIVER_MESSAGE);
    throw err;
  }
}

export async function setDriverActive(id, active) {
  await updateRowOrThrow('drivers', id, { active });
}

// ---------------------------------------------------------------------------
// admin: driver incidents (customer complaints) CRUD
// ---------------------------------------------------------------------------
export async function fetchDriverIncidents() {
  const { data, error } = await supabase
    .from('driver_incidents')
    .select('*, drivers(name)')
    .order('reported_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createDriverIncident(driverId, customerName, description) {
  const { data, error } = await supabase
    .from('driver_incidents')
    .insert({ driver_id: driverId, customer_name: customerName || null, description })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateDriverIncident(id, { driver_id, customer_name, description, resolution_notes }) {
  await updateRowOrThrow('driver_incidents', id, {
    driver_id,
    customer_name: customer_name || null,
    description,
    resolution_notes: resolution_notes || null,
  });
}

export async function setDriverIncidentStatus(id, resolved) {
  await updateRowOrThrow('driver_incidents', id, {
    status: resolved ? 'resolved' : 'open',
    resolved_at: resolved ? new Date().toISOString() : null,
  });
}

export async function fetchVehiclesWithAvailability() {
  const [{ data: vehicles, error: vErr }, { data: openSessions, error: sErr }] =
    await Promise.all([
      supabase.from('vehicles').select('*').eq('active', true).order('name'),
      supabase
        .from('driving_sessions')
        .select('id, vehicle_id, driver_id, start_time, drivers(name)')
        .is('end_time', null),
    ]);
  if (vErr) throw vErr;
  if (sErr) throw sErr;

  const sessionByVehicle = new Map(openSessions.map((s) => [s.vehicle_id, s]));
  return vehicles.map((v) => ({ ...v, activeSession: sessionByVehicle.get(v.id) || null }));
}

// ---------------------------------------------------------------------------
// driving sessions (get a vehicle / end my shift)
// ---------------------------------------------------------------------------
export async function checkoutVehicle(driverId, vehicleId) {
  const { data, error } = await supabase
    .from('driving_sessions')
    .insert({ driver_id: driverId, vehicle_id: vehicleId })
    .select('*, drivers(name), vehicles(name, color_name, color_hex)')
    .single();

  if (error) {
    // Unique violation on driving_sessions_one_active_per_vehicle: someone
    // else's checkout landed first.
    if (error.code === '23505') {
      throw new Error('That vehicle was just checked out by someone else. Pick another.');
    }
    throw error;
  }
  return data;
}

export async function fetchOpenSessions() {
  const { data, error } = await supabase
    .from('driving_sessions')
    .select('*, drivers(name), vehicles(name, color_name, color_hex)')
    .is('end_time', null)
    .order('start_time', { ascending: true });
  if (error) throw error;
  return data;
}

export async function fetchChecklistItems() {
  const { data, error } = await supabase
    .from('checklist_items')
    .select('*')
    .eq('active', true)
    .order('sort_order');
  if (error) throw error;
  return data;
}

export async function returnVehicle(sessionId, itemIds, notes) {
  // These used to run in parallel, which meant a lost race (someone else closed
  // this session first) left checklist rows attached to a session this driver
  // didn't close — and the `.is('end_time', null)` guard matched zero rows,
  // which PostgREST reports as success, so the driver saw "Vehicle returned"
  // for a return that never happened.
  //
  // Now: record the checklist first (ignore-duplicates makes a retry a no-op
  // rather than a unique violation on session_id+item_id), then close the
  // session as the authoritative step, and surface a zero-row close as an error.
  const rows = itemIds.map((itemId) => ({ session_id: sessionId, item_id: itemId, checked: true }));
  if (rows.length > 0) {
    const { error: itemsError } = await supabase
      .from('driving_session_checklist_items')
      .upsert(rows, { onConflict: 'session_id,item_id', ignoreDuplicates: true });
    if (itemsError) throw itemsError;
  }

  const { data, error } = await supabase
    .from('driving_sessions')
    .update({
      end_time: new Date().toISOString(),
      checklist_completed: true,
      return_notes: notes || null,
    })
    .eq('id', sessionId)
    .is('end_time', null)
    .select('id');
  if (error) throw error;
  if (data.length === 0) {
    throw new Error('This shift was already signed out — the board is being refreshed.');
  }
}

// ---------------------------------------------------------------------------
// hot bags
// ---------------------------------------------------------------------------
export async function fetchHotBags() {
  const { data, error } = await supabase
    .from('hot_bags')
    .select('*')
    .eq('active', true)
    .order('name');
  if (error) throw error;
  return data;
}

export async function markHotBagCleaned(bagId) {
  await updateRowOrThrow('hot_bags', bagId, { last_cleaned: new Date().toISOString() });
}

export async function reportHotBagIssue(bagId, issue, notes) {
  const { error } = await supabase
    .from('hot_bag_maintenance')
    .insert({ bag_id: bagId, issue, notes: notes || null });
  if (error) throw error;
}

export async function fetchHotBagMaintenanceHistory(limit = HISTORY_PAGE_SIZE) {
  const { data, error } = await supabase
    .from('hot_bag_maintenance')
    .select('*, hot_bags(name)')
    .order('submitted_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// admin: hot bags CRUD
// ---------------------------------------------------------------------------
export async function fetchAllHotBags() {
  const { data, error } = await supabase
    .from('hot_bags')
    .select('*')
    .order('active', { ascending: false })
    .order('name');
  if (error) throw error;
  return data;
}

export async function createHotBag(name, cleanWindowDays) {
  const { data, error } = await supabase
    .from('hot_bags')
    .insert({ name, clean_window_days: cleanWindowDays })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateHotBag(id, { name, clean_window_days }) {
  await updateRowOrThrow('hot_bags', id, { name, clean_window_days });
}

export async function setHotBagActive(id, active) {
  await updateRowOrThrow('hot_bags', id, { active });
}

// ---------------------------------------------------------------------------
// slow tasks
// ---------------------------------------------------------------------------
export async function fetchSlowTasks() {
  const { data, error } = await supabase
    .from('slow_tasks')
    .select('*')
    .eq('active', true)
    .order('next_due');
  if (error) throw error;
  return data;
}

export async function completeSlowTask(taskId, driverId, notes) {
  const { error } = await supabase
    .from('slow_task_completions')
    .insert({ task_id: taskId, completed_by: driverId || null, notes: notes || null });
  if (error) throw error;

  // Sequential, and routed through updateRowOrThrow: the old parallel version
  // reported success even when the update matched zero rows, so a task could
  // log a completion and never advance its next_due. The slow_tasks_before_write
  // trigger recomputes next_due from last_completed.
  await updateRowOrThrow('slow_tasks', taskId, { last_completed: new Date().toISOString() });
}

export async function fetchSlowTaskCompletions(taskId) {
  const { data, error } = await supabase
    .from('slow_task_completions')
    .select('*, drivers(name)')
    .eq('task_id', taskId)
    .order('completed_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// admin: slow tasks CRUD
// ---------------------------------------------------------------------------
export async function fetchAllSlowTasks() {
  const { data, error } = await supabase
    .from('slow_tasks')
    .select('*')
    .order('active', { ascending: false })
    .order('next_due');
  if (error) throw error;
  return data;
}

export async function createSlowTask(name, description, frequencyDays) {
  const { data, error } = await supabase
    .from('slow_tasks')
    .insert({ name, description: description || null, frequency_days: frequencyDays })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateSlowTask(id, { name, description, frequency_days }) {
  await updateRowOrThrow('slow_tasks', id, { name, description: description || null, frequency_days });
}

export async function setSlowTaskActive(id, active) {
  await updateRowOrThrow('slow_tasks', id, { active });
}

// ---------------------------------------------------------------------------
// admin: history views
// ---------------------------------------------------------------------------
export async function fetchDriverHistory(limit = HISTORY_PAGE_SIZE) {
  const { data, error } = await supabase
    .from('driving_sessions')
    .select('*, drivers(name), vehicles(name, color_name, color_hex)')
    .order('start_time', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function fetchVehicleHistory(vehicleId) {
  const { data, error } = await supabase
    .from('driving_sessions')
    .select('*, drivers(name)')
    .eq('vehicle_id', vehicleId)
    .order('start_time', { ascending: false });
  if (error) throw error;
  return data;
}
