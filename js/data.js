// All Supabase query logic, as a factory over a client.
//
// The client is a parameter rather than a module-level singleton so this file
// can be exercised in tests: js/supabase.js imports the real client from a CDN
// URL, which Node cannot resolve, and a network round trip is the wrong thing
// to assert against anyway. tests/ passes in a fake that records calls.
//
// No mileage fields exist anywhere in this file, on purpose.

// The admin history screens used to select every row ever written with no
// bound, so they got slower and heavier every week the app ran. They're
// newest-first, and nobody scrolls past a few hundred rows on an iPad, so cap
// the fetch and let the UI say when it's truncated.
export const HISTORY_PAGE_SIZE = 500;

// How many recent sessions to scan when working out who drove lately. Sixty is
// several days of a four-vehicle fleet — deep enough that the recent list is
// stable, shallow enough to stay a cheap read on the identity screen.
export const RECENT_SESSION_SCAN = 60;

// The vehicle_status enum in sql/schema.sql, with the labels the admin shows.
// Kept beside the data layer so adding a status means touching one list, not
// hunting for every place the raw column value gets turned into words.
export const VEHICLE_STATUSES = [
  { value: 'available', label: 'Available' },
  { value: 'needs_attention', label: 'Needs Attention' },
  { value: 'out_of_service', label: 'Out of Service' },
];

export function createDataApi(supabase) {
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
  async function fetchActiveDrivers() {
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

  async function createDriver(name, employeeNumber = null) {
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
  async function findDriverByName(name) {
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
  async function fetchAllDrivers() {
    const { data, error } = await supabase
      .from('drivers')
      .select('*')
      .order('active', { ascending: false })
      .order('name');
    if (error) throw error;
    return data;
  }

  async function updateDriver(id, { name, employee_number }) {
    try {
      await updateRowOrThrow('drivers', id, { name, employee_number: employee_number || null });
    } catch (err) {
      if (err.code === '23505') throw new Error(DUPLICATE_DRIVER_MESSAGE);
      throw err;
    }
  }

  async function setDriverActive(id, active) {
    await updateRowOrThrow('drivers', id, { active });
  }

  // ---------------------------------------------------------------------------
  // admin: driver incidents (customer complaints) CRUD
  // ---------------------------------------------------------------------------
  // The history view, capped like every other history read. Counting open
  // incidents must NOT derive from this — see fetchOpenDriverIncidents.
  async function fetchDriverIncidents(limit = HISTORY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('driver_incidents')
      .select('*, drivers(name)')
      .order('reported_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  // The dashboard tile and the per-driver counts on the Drivers table used to
  // filter the capped history fetch above, so an open incident older than the
  // newest HISTORY_PAGE_SIZE rows silently stopped being counted — the number
  // drifted low as history grew, on the one screen that exists to surface it.
  // Read the open rows directly instead: resolved rows are what accumulate
  // forever, open ones get closed, so this set stays small without a cap.
  async function fetchOpenDriverIncidents() {
    const { data, error } = await supabase
      .from('driver_incidents')
      .select('id, driver_id')
      .eq('status', 'open');
    if (error) throw error;
    return data;
  }

  async function createDriverIncident(driverId, customerName, description) {
    const { data, error } = await supabase
      .from('driver_incidents')
      .insert({ driver_id: driverId, customer_name: customerName || null, description })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async function updateDriverIncident(id, { driver_id, customer_name, description, resolution_notes }) {
    await updateRowOrThrow('driver_incidents', id, {
      driver_id,
      customer_name: customer_name || null,
      description,
      resolution_notes: resolution_notes || null,
    });
  }

  async function setDriverIncidentStatus(id, resolved) {
    await updateRowOrThrow('driver_incidents', id, {
      status: resolved ? 'resolved' : 'open',
      resolved_at: resolved ? new Date().toISOString() : null,
    });
  }

  // The kiosk board shows active vehicles only. The admin Vehicles screen passes
  // includeInactive so retired ones stay reachable and can be brought back —
  // they are never deleted, because driving_sessions still point at them.
  async function fetchVehiclesWithAvailability({ includeInactive = false } = {}) {
    let vehicleQuery = supabase.from('vehicles').select('*');
    if (includeInactive) vehicleQuery = vehicleQuery.order('active', { ascending: false });
    else vehicleQuery = vehicleQuery.eq('active', true);
    vehicleQuery = vehicleQuery.order('name');

    const [{ data: vehicles, error: vErr }, { data: openSessions, error: sErr }] =
      await Promise.all([
        vehicleQuery,
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
  // admin: vehicles CRUD
  //
  // Vehicles were reference data edited only in the Supabase SQL editor for far
  // too long. Taking a car off the road is the most time-critical edit in the
  // app — it happens on a Saturday, not at a desk — and it was the one thing
  // that needed a developer.
  // ---------------------------------------------------------------------------
  async function createVehicle({ name, color_name, color_hex, status = 'available' }) {
    const { data, error } = await supabase
      .from('vehicles')
      .insert({ name, color_name, color_hex, status })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async function updateVehicle(id, { name, color_name, color_hex, status }) {
    await updateRowOrThrow('vehicles', id, { name, color_name, color_hex, status });
  }

  // Status is the vehicle's condition. Whether it is currently checked out is a
  // separate thing entirely, derived from driving_sessions — an out-of-service
  // car can still have an open session that a driver needs to close normally.
  async function setVehicleStatus(id, status) {
    await updateRowOrThrow('vehicles', id, { status });
  }

  async function setVehicleActive(id, active) {
    await updateRowOrThrow('vehicles', id, { active });
  }

  // ---------------------------------------------------------------------------
  // driving sessions (get a vehicle / end my shift)
  // ---------------------------------------------------------------------------
  async function checkoutVehicle(driverId, vehicleId) {
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

  // Admin cleanup for a shift the driver never signed out of. Deliberately not
  // automatic and deliberately not disguised as a normal return: end_time is the
  // moment an admin acted, checklist_completed stays false, and the note says who
  // closed it. That keeps a real return distinguishable from a cleanup forever.
  async function forceCloseSession(sessionId, note) {
    const { data, error } = await supabase
      .from('driving_sessions')
      .update({
        end_time: new Date().toISOString(),
        checklist_completed: false,
        return_notes: note,
      })
      .eq('id', sessionId)
      .is('end_time', null)
      .select('id');
    if (error) throw error;
    if (data.length === 0) {
      throw new Error('That shift is already closed — the dashboard is out of date.');
    }
  }

  // Who drove most recently, newest first, deduplicated. The identity screen
  // orders the roster by this so that on a churning roster most drivers never
  // type anything: whoever drove this week is overwhelmingly who is driving now.
  //
  // Derived from driving_sessions rather than a denormalised "last drove" column
  // on drivers — the answer is already here, and a cached copy would be one more
  // thing every checkout has to remember to keep correct.
  async function fetchRecentDriverIds(limit = RECENT_SESSION_SCAN) {
    const { data, error } = await supabase
      .from('driving_sessions')
      .select('driver_id')
      .order('start_time', { ascending: false })
      .limit(limit);
    if (error) throw error;

    const ordered = [];
    const seen = new Set();
    for (const row of data) {
      if (row.driver_id && !seen.has(row.driver_id)) {
        seen.add(row.driver_id);
        ordered.push(row.driver_id);
      }
    }
    return ordered;
  }

  async function fetchOpenSessions() {
    const { data, error } = await supabase
      .from('driving_sessions')
      .select('*, drivers(name), vehicles(name, color_name, color_hex)')
      .is('end_time', null)
      .order('start_time', { ascending: true });
    if (error) throw error;
    return data;
  }

  async function fetchChecklistItems() {
    const { data, error } = await supabase
      .from('checklist_items')
      .select('*')
      .eq('active', true)
      .order('sort_order');
    if (error) throw error;
    return data;
  }

  // ---------------------------------------------------------------------------
  // admin: return-checklist items CRUD
  //
  // These used to be SQL-only reference data. They're the questions every driver
  // answers at the end of every shift, so leadership needs to change them without
  // a developer. Never deleted — deactivating keeps historical
  // driving_session_checklist_items rows pointing at a real label.
  // ---------------------------------------------------------------------------
  async function fetchAllChecklistItems() {
    const { data, error } = await supabase
      .from('checklist_items')
      .select('*')
      .order('active', { ascending: false })
      .order('sort_order');
    if (error) throw error;
    return data;
  }

  async function createChecklistItem(label, sortOrder) {
    const { data, error } = await supabase
      .from('checklist_items')
      .insert({ label, sort_order: sortOrder })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async function updateChecklistItem(id, { label }) {
    await updateRowOrThrow('checklist_items', id, { label });
  }

  async function setChecklistItemActive(id, active) {
    await updateRowOrThrow('checklist_items', id, { active });
  }

  // Takes the full desired order and rewrites sort_order as 1..n. Swapping a
  // pair would be fewer writes, but it silently does nothing when two rows share
  // a sort_order — renumbering can't drift.
  async function reorderChecklistItems(orderedIds) {
    for (const [index, id] of orderedIds.entries()) {
      await updateRowOrThrow('checklist_items', id, { sort_order: index + 1 });
    }
  }

  async function returnVehicle(sessionId, itemIds, notes) {
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
  async function fetchHotBags() {
    const { data, error } = await supabase
      .from('hot_bags')
      .select('*')
      .eq('active', true)
      .order('name');
    if (error) throw error;
    return data;
  }

  async function markHotBagCleaned(bagId) {
    await updateRowOrThrow('hot_bags', bagId, { last_cleaned: new Date().toISOString() });
  }

  async function reportHotBagIssue(bagId, issue, notes) {
    const { error } = await supabase
      .from('hot_bag_maintenance')
      .insert({ bag_id: bagId, issue, notes: notes || null });
    if (error) throw error;
  }

  // Resolving is an update, never a delete: the maintenance log is history.
  // Mirrors setDriverIncidentStatus — same open/resolved pair, same nulling of
  // the timestamp on reopen so a reopened issue doesn't keep a stale
  // resolved_at.
  async function setHotBagIssueStatus(id, resolved) {
    await updateRowOrThrow('hot_bag_maintenance', id, {
      status: resolved ? 'resolved' : 'open',
      resolved_at: resolved ? new Date().toISOString() : null,
    });
  }

  // Counterpart to fetchOpenDriverIncidents, for the dashboard tile and the
  // per-bag Open Issues column. Same trap, same fix.
  async function fetchOpenHotBagIssues() {
    const { data, error } = await supabase
      .from('hot_bag_maintenance')
      .select('id, bag_id')
      .eq('status', 'open');
    if (error) throw error;
    return data;
  }

  async function fetchHotBagMaintenanceHistory(limit = HISTORY_PAGE_SIZE) {
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
  async function fetchAllHotBags() {
    const { data, error } = await supabase
      .from('hot_bags')
      .select('*')
      .order('active', { ascending: false })
      .order('name');
    if (error) throw error;
    return data;
  }

  async function createHotBag(name, cleanWindowDays) {
    const { data, error } = await supabase
      .from('hot_bags')
      .insert({ name, clean_window_days: cleanWindowDays })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async function updateHotBag(id, { name, clean_window_days }) {
    await updateRowOrThrow('hot_bags', id, { name, clean_window_days });
  }

  async function setHotBagActive(id, active) {
    await updateRowOrThrow('hot_bags', id, { active });
  }

  // ---------------------------------------------------------------------------
  // slow tasks
  // ---------------------------------------------------------------------------
  async function fetchSlowTasks() {
    const { data, error } = await supabase
      .from('slow_tasks')
      .select('*')
      .eq('active', true)
      .order('next_due');
    if (error) throw error;
    return data;
  }

  async function completeSlowTask(taskId, driverId, notes) {
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

  async function fetchSlowTaskCompletions(taskId, limit = HISTORY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('slow_task_completions')
      .select('*, drivers(name)')
      .eq('task_id', taskId)
      .order('completed_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  // ---------------------------------------------------------------------------
  // admin: slow tasks CRUD
  // ---------------------------------------------------------------------------
  async function fetchAllSlowTasks() {
    const { data, error } = await supabase
      .from('slow_tasks')
      .select('*')
      .order('active', { ascending: false })
      .order('next_due');
    if (error) throw error;
    return data;
  }

  async function createSlowTask(name, description, frequencyDays) {
    const { data, error } = await supabase
      .from('slow_tasks')
      .insert({ name, description: description || null, frequency_days: frequencyDays })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async function updateSlowTask(id, { name, description, frequency_days }) {
    await updateRowOrThrow('slow_tasks', id, { name, description: description || null, frequency_days });
  }

  async function setSlowTaskActive(id, active) {
    await updateRowOrThrow('slow_tasks', id, { active });
  }

  // ---------------------------------------------------------------------------
  // admin: history views
  // ---------------------------------------------------------------------------
  async function fetchDriverHistory(limit = HISTORY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('driving_sessions')
      .select('*, drivers(name), vehicles(name, color_name, color_hex)')
      .order('start_time', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  async function fetchVehicleHistory(vehicleId, limit = HISTORY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('driving_sessions')
      .select('*, drivers(name)')
      .eq('vehicle_id', vehicleId)
      .order('start_time', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  return {
    fetchActiveDrivers,
    createDriver,
    findDriverByName,
    fetchAllDrivers,
    updateDriver,
    setDriverActive,
    fetchDriverIncidents,
    fetchOpenDriverIncidents,
    createDriverIncident,
    updateDriverIncident,
    setDriverIncidentStatus,
    fetchVehiclesWithAvailability,
    createVehicle,
    updateVehicle,
    setVehicleStatus,
    setVehicleActive,
    checkoutVehicle,
    forceCloseSession,
    fetchOpenSessions,
    fetchRecentDriverIds,
    fetchChecklistItems,
    fetchAllChecklistItems,
    createChecklistItem,
    updateChecklistItem,
    setChecklistItemActive,
    reorderChecklistItems,
    returnVehicle,
    fetchHotBags,
    markHotBagCleaned,
    reportHotBagIssue,
    setHotBagIssueStatus,
    fetchHotBagMaintenanceHistory,
    fetchOpenHotBagIssues,
    fetchAllHotBags,
    createHotBag,
    updateHotBag,
    setHotBagActive,
    fetchSlowTasks,
    completeSlowTask,
    fetchSlowTaskCompletions,
    fetchAllSlowTasks,
    createSlowTask,
    updateSlowTask,
    setSlowTaskActive,
    fetchDriverHistory,
    fetchVehicleHistory,
  };
}
