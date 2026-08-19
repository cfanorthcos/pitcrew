// Binds the data API to the live Supabase client. All query logic lives in
// data.js; this file exists only to construct the real client and re-export the
// same names app.js and admin.js have always imported.

// Pinned to an exact version on purpose. `@2` resolves to whatever esm.sh
// considers newest at page load, so an upstream release could break the kiosk
// mid-shift with no deploy on our side. Bump this deliberately and test.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
import { createDataApi, HISTORY_PAGE_SIZE } from './data.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

export { HISTORY_PAGE_SIZE };

export const {
  fetchActiveDrivers,
  createDriver,
  findDriverByName,
  fetchAllDrivers,
  updateDriver,
  setDriverActive,
  fetchDriverIncidents,
  createDriverIncident,
  updateDriverIncident,
  setDriverIncidentStatus,
  fetchVehiclesWithAvailability,
  checkoutVehicle,
  forceCloseSession,
  fetchOpenSessions,
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
  fetchHotBagMaintenanceHistory,
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
} = createDataApi(supabase);
