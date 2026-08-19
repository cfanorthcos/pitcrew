import {
  fetchVehiclesWithAvailability,
  fetchOpenSessions,
  forceCloseSession,
  fetchAllDrivers,
  createDriver,
  updateDriver,
  setDriverActive,
  fetchDriverIncidents,
  createDriverIncident,
  updateDriverIncident,
  setDriverIncidentStatus,
  fetchHotBags,
  fetchAllHotBags,
  createHotBag,
  updateHotBag,
  setHotBagActive,
  fetchHotBagMaintenanceHistory,
  fetchSlowTasks,
  fetchAllSlowTasks,
  createSlowTask,
  updateSlowTask,
  setSlowTaskActive,
  fetchSlowTaskCompletions,
  fetchAllChecklistItems,
  createChecklistItem,
  updateChecklistItem,
  setChecklistItemActive,
  reorderChecklistItems,
  fetchDriverHistory,
  fetchVehicleHistory,
  HISTORY_PAGE_SIZE,
} from './supabase.js';
import { HOT_BAG_CLEAN_WINDOW_DAYS, ADMIN_PIN, SHIFT_OVERDUE_HOURS } from './config.js';
import {
  escapeHtml,
  formatDate,
  formatDateTime,
  frequencyLabel,
  isNeedsCleaning,
  isTaskDue,
  isShiftOverdue,
  formatElapsed,
  showError,
  showSuccess,
  initOfflineBanner,
  openModal,
  closeModal,
  startTicker,
  refreshTickers,
} from './ui.js';

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
function statCard(value, label, goto, tone = '') {
  return `
    <button type="button" class="card stat-card ${tone}" data-goto="${escapeHtml(goto)}">
      <span class="value">${value}</span>
      <span class="label">${escapeHtml(label)}</span>
    </button>
  `;
}

async function renderDashboard() {
  const container = document.getElementById('section-dashboard');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    // driver_incidents is fetched best-effort so the dashboard still renders on
    // a project whose schema migration hasn't been applied yet.
    const [vehicles, openSessions, hotBags, maintenance, slowTasks, incidents] = await Promise.all([
      fetchVehiclesWithAvailability(),
      fetchOpenSessions(),
      fetchHotBags(),
      fetchHotBagMaintenanceHistory(),
      fetchSlowTasks(),
      fetchDriverIncidents().catch(() => []),
    ]);

    const out = vehicles.filter((v) => v.activeSession).length;
    const free = vehicles.filter((v) => !v.activeSession && v.status !== 'out_of_service').length;
    const needsCleaning = hotBags.filter(isNeedsCleaning).length;
    const dueTasks = slowTasks.filter(isTaskDue).length;
    const openIssues = maintenance.filter((m) => m.status === 'open').length;
    const openIncidents = incidents.filter((i) => i.status === 'open').length;

    const overdueSessions = openSessions.filter((s) => isShiftOverdue(s.start_time));
    const shiftRows = openSessions
      .map((s) => {
        const overdue = isShiftOverdue(s.start_time);
        return `
          <tr>
            <td><strong>${escapeHtml(s.drivers?.name ?? '—')}</strong></td>
            <td>${escapeHtml(s.vehicles?.name ?? '—')}</td>
            <td>${formatDateTime(s.start_time)}</td>
            <td><span class="elapsed ${
              overdue ? 'is-overdue' : ''
            }" data-since="${escapeHtml(s.start_time)}">—</span></td>
            <td>${
              overdue
                ? '<span class="badge badge-warn">Overdue</span>'
                : '<span class="badge badge-neutral">On shift</span>'
            }</td>
            <td>${
              overdue
                ? `<button type="button" class="btn btn-secondary btn-sm force-close-btn" data-session-id="${escapeHtml(
                    s.id,
                  )}">Force Close</button>`
                : ''
            }</td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="stat-grid">
        ${statCard(out, 'Vehicles Out', 'vehicles')}
        ${statCard(free, 'Vehicles Free', 'vehicles')}
        ${statCard(needsCleaning, 'Hot Bags Needing Cleaning', 'hotbags', needsCleaning ? 'is-warn' : '')}
        ${statCard(dueTasks, 'Slow Tasks Due', 'slowtasks', dueTasks ? 'is-warn' : '')}
        ${statCard(openIssues, 'Open Bag Issues', 'hotbags', openIssues ? 'is-warn' : '')}
        ${statCard(openIncidents, 'Open Driver Incidents', 'incidents', openIncidents ? 'is-bad' : '')}
      </div>

      <div class="section-toolbar">
        <h2 class="section-title">On Shift Right Now</h2>
        ${
          overdueSessions.length
            ? `<p class="section-hint">${overdueSessions.length} past ${SHIFT_OVERDUE_HOURS}h without signing out.</p>`
            : ''
        }
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Driver</th><th>Vehicle</th><th>Started</th><th>Elapsed</th><th>State</th><th></th></tr></thead>
          <tbody>${shiftRows || '<tr><td colspan="6">Nobody is out right now.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    container.querySelectorAll('[data-goto]').forEach((el) => {
      el.addEventListener('click', () => switchSection(el.dataset.goto));
    });

    container.querySelectorAll('.force-close-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openForceCloseModal(openSessions.find((s) => s.id === btn.dataset.sessionId));
      });
    });
    refreshTickers();
  } catch {
    showError('Could not load dashboard data. Check your connection.');
    container.innerHTML = '<p class="empty-state">Could not load dashboard data.</p>';
  }
}

// Confirmation rather than a one-tap action: this writes an end_time that isn't
// a real return, so the admin should see exactly what they're recording.
function openForceCloseModal(session) {
  const driverName = session.drivers?.name ?? 'Unknown driver';
  const vehicleName = session.vehicles?.name ?? 'this vehicle';
  const defaultNote = `Closed by admin — driver did not sign out (was out ${formatElapsed(
    session.start_time,
  )}).`;

  const sheet = openModal(
    `Force close ${driverName}'s shift`,
    `
      <h2>Force Close Shift</h2>
      <p class="meta">${escapeHtml(driverName)} · ${escapeHtml(vehicleName)}</p>
      <div class="card-row">
        <div class="confirm-detail">Started<strong>${formatDateTime(session.start_time)}</strong></div>
        <div class="confirm-detail">Out for<strong>${escapeHtml(formatElapsed(session.start_time))}</strong></div>
      </div>
      <p class="meta">
        This frees ${escapeHtml(vehicleName)} on the board. It records the shift as
        closed by you, right now, with the checklist marked incomplete — not as a
        normal return.
      </p>
      <div>
        <label class="field-label" for="force-close-note">Note saved to history</label>
        <textarea id="force-close-note">${escapeHtml(defaultNote)}</textarea>
      </div>
      <button type="button" class="btn btn-primary" id="force-close-confirm">Force Close Shift</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const confirmBtn = sheet.querySelector('#force-close-confirm');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Closing…';
    try {
      const note = sheet.querySelector('#force-close-note').value.trim();
      await forceCloseSession(session.id, note || defaultNote);
      closeModal();
      showSuccess(`${vehicleName} is available again.`);
      await renderDashboard();
    } catch (err) {
      showError(err.message || 'Could not close this shift. Try again.');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Force Close Shift';
    }
  });
}

// ---------------------------------------------------------------------------
// vehicles
// ---------------------------------------------------------------------------
function vehicleStatusDisplay(vehicle) {
  if (vehicle.activeSession) return { label: 'In Use', badge: 'badge-neutral' };
  if (vehicle.status === 'available') return { label: 'Available', badge: 'badge-good' };
  if (vehicle.status === 'needs_attention') return { label: 'Needs Attention', badge: 'badge-warn' };
  return { label: 'Out of Service', badge: 'badge-bad' };
}

async function renderVehicles() {
  const container = document.getElementById('section-vehicles');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const vehicles = await fetchVehiclesWithAvailability();
    const rows = vehicles
      .map((v) => {
        const status = vehicleStatusDisplay(v);
        return `
          <tr class="clickable" data-vehicle-id="${escapeHtml(v.id)}">
            <td><strong>${escapeHtml(v.name)}</strong></td>
            <td>${escapeHtml(v.color_name)}</td>
            <td><span class="badge ${status.badge}">${status.label}</span></td>
            <td>${v.activeSession ? escapeHtml(v.activeSession.drivers?.name ?? '—') : '—'}</td>
            <td>${v.activeSession ? formatDateTime(v.activeSession.start_time) : '—'}</td>
            <td>${
              v.activeSession
                ? `<span class="elapsed" data-since="${escapeHtml(v.activeSession.start_time)}">—</span>`
                : '—'
            }</td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="section-toolbar">
        <h2 class="section-title">Vehicles</h2>
        <p class="section-hint">Tap a row for its full driving history.</p>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Vehicle</th><th>Color</th><th>Status</th><th>Current Driver</th><th>Shift Started</th><th>Elapsed</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6">No vehicles configured.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    container.querySelectorAll('tr[data-vehicle-id]').forEach((row) => {
      row.addEventListener('click', () => {
        showVehicleDetail(vehicles.find((v) => v.id === row.dataset.vehicleId));
      });
    });
    refreshTickers();
  } catch {
    showError('Could not load vehicles. Check your connection.');
    container.innerHTML = '<p class="empty-state">Could not load vehicles.</p>';
  }
}

async function showVehicleDetail(vehicle) {
  showSection('vehicle-detail');
  const container = document.getElementById('section-vehicle-detail');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const history = await fetchVehicleHistory(vehicle.id);
    const rows = history
      .map(
        (s) => `
          <tr>
            <td>${escapeHtml(s.drivers?.name ?? '—')}</td>
            <td>${formatDateTime(s.start_time)}</td>
            <td>${formatDateTime(s.end_time)}</td>
            <td>${s.checklist_completed ? 'Yes' : 'No'}</td>
            <td>${escapeHtml(s.return_notes ?? '—')}</td>
          </tr>
        `,
      )
      .join('');

    container.innerHTML = `
      <button type="button" class="back-link" id="vehicle-detail-back">‹ Back to vehicles</button>
      <h2 class="section-title">${escapeHtml(vehicle.name)} — Driving History</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Driver</th><th>Start</th><th>End</th><th>Checklist</th><th>Notes</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5">No driving history yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
    container.querySelector('#vehicle-detail-back').addEventListener('click', () => switchSection('vehicles'));
  } catch {
    showError('Could not load vehicle history.');
    container.innerHTML = '<p class="empty-state">Could not load vehicle history.</p>';
  }
}

// ---------------------------------------------------------------------------
// drivers (full CRUD)
// ---------------------------------------------------------------------------
function openDriverModal(driver = null) {
  const isEdit = Boolean(driver);
  const sheet = openModal(
    isEdit ? `Edit ${driver.name}` : 'Add a driver',
    `
      <h2>${isEdit ? 'Edit Driver' : 'Add Driver'}</h2>
      <div>
        <label class="field-label" for="driver-name-input">Name</label>
        <input type="text" id="driver-name-input" placeholder="Full name" value="${escapeHtml(driver?.name ?? '')}" />
      </div>
      <div>
        <label class="field-label" for="driver-employee-input">Employee Number</label>
        <input type="text" id="driver-employee-input" placeholder="Optional" value="${escapeHtml(
          driver?.employee_number ?? '',
        )}" />
      </div>
      <button type="button" class="btn btn-primary" id="driver-save-btn">${
        isEdit ? 'Save Changes' : 'Add Driver'
      }</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const saveBtn = sheet.querySelector('#driver-save-btn');
  saveBtn.addEventListener('click', async () => {
    const name = sheet.querySelector('#driver-name-input').value.trim();
    if (!name) {
      showError('Name is required.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const employeeNumber = sheet.querySelector('#driver-employee-input').value.trim();
      if (isEdit) await updateDriver(driver.id, { name, employee_number: employeeNumber });
      else await createDriver(name, employeeNumber);
      closeModal();
      showSuccess(isEdit ? 'Driver updated.' : `${name} added.`);
      await renderDrivers();
    } catch (err) {
      showError(err.message || 'Could not save this driver. Try again.');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Driver';
    }
  });
}

async function renderDrivers() {
  const container = document.getElementById('section-drivers');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const drivers = await fetchAllDrivers();
    // Best-effort: the Drivers tab still works even if driver_incidents isn't
    // there yet (e.g. schema migration not applied) — it just shows 0 open
    // incidents everywhere instead of failing the whole section.
    const incidents = await fetchDriverIncidents().catch(() => []);

    const openByDriver = new Map();
    incidents
      .filter((i) => i.status === 'open')
      .forEach((i) => openByDriver.set(i.driver_id, (openByDriver.get(i.driver_id) || 0) + 1));

    const rows = drivers
      .map((d) => {
        const openCount = openByDriver.get(d.id) || 0;
        return `
          <tr class="${d.active ? '' : 'is-inactive'}">
            <td><strong>${escapeHtml(d.name)}</strong></td>
            <td>${escapeHtml(d.employee_number ?? '—')}</td>
            <td><span class="badge ${d.active ? 'badge-good' : 'badge-muted'}">${
              d.active ? 'Active' : 'Inactive'
            }</span></td>
            <td>${openCount > 0 ? `<span class="badge badge-warn">${openCount}</span>` : '0'}</td>
            <td>
              <div class="row-actions">
                <button type="button" class="btn btn-secondary btn-sm edit-driver-btn" data-driver-id="${escapeHtml(
                  d.id,
                )}">Edit</button>
                <button type="button" class="btn btn-secondary btn-sm toggle-driver-btn" data-driver-id="${escapeHtml(
                  d.id,
                )}">${d.active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="section-toolbar">
        <h2 class="section-title">Drivers</h2>
        <button type="button" class="btn btn-primary btn-auto" id="add-driver-btn">+ Add Driver</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Name</th><th>Employee #</th><th>Status</th><th>Open Incidents</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5">No drivers yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    container.querySelector('#add-driver-btn').addEventListener('click', () => openDriverModal());

    container.querySelectorAll('.edit-driver-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openDriverModal(drivers.find((d) => d.id === btn.dataset.driverId));
      });
    });

    container.querySelectorAll('.toggle-driver-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const driver = drivers.find((d) => d.id === btn.dataset.driverId);
        btn.disabled = true;
        try {
          await setDriverActive(driver.id, !driver.active);
          await renderDrivers();
        } catch (err) {
          showError(err.message || 'Could not update this driver. Try again.');
          btn.disabled = false;
        }
      });
    });
  } catch {
    showError('Could not load drivers. Check your connection.');
    container.innerHTML = '<p class="empty-state">Could not load drivers.</p>';
  }
}

// ---------------------------------------------------------------------------
// driver history
// ---------------------------------------------------------------------------
async function renderDriverHistory() {
  const container = document.getElementById('section-driver-history');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const sessions = await fetchDriverHistory();
    const rows = sessions
      .map(
        (s) => `
          <tr>
            <td><strong>${escapeHtml(s.drivers?.name ?? '—')}</strong></td>
            <td>${escapeHtml(s.vehicles?.name ?? '—')}</td>
            <td>${formatDateTime(s.start_time)}</td>
            <td>${formatDateTime(s.end_time)}</td>
            <td>${
              s.end_time
                ? `<span class="badge badge-good">Closed</span>`
                : `<span class="badge badge-neutral">Open</span>`
            }</td>
            <td>${s.checklist_completed ? 'Yes' : 'No'}</td>
            <td>${escapeHtml(s.return_notes ?? '—')}</td>
          </tr>
        `,
      )
      .join('');

    const truncated = sessions.length >= HISTORY_PAGE_SIZE;
    container.innerHTML = `
      <div class="section-toolbar">
        <h2 class="section-title">Driver History</h2>
        ${
          truncated
            ? `<p class="section-hint">Showing the ${HISTORY_PAGE_SIZE} most recent shifts.</p>`
            : ''
        }
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Driver</th><th>Vehicle</th><th>Start</th><th>End</th><th>Shift</th><th>Checklist</th><th>Notes</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7">No driving history yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  } catch {
    showError('Could not load driver history.');
    container.innerHTML = '<p class="empty-state">Could not load driver history.</p>';
  }
}

// ---------------------------------------------------------------------------
// return checklist (the questions drivers answer when signing out)
// ---------------------------------------------------------------------------
function openChecklistItemModal(item = null, nextSortOrder = 1) {
  const isEdit = Boolean(item);
  const sheet = openModal(
    isEdit ? `Edit ${item.label}` : 'Add a checklist item',
    `
      <h2>${isEdit ? 'Edit Checklist Item' : 'Add Checklist Item'}</h2>
      <p class="meta">Drivers must tick every active item before they can sign out.</p>
      <div>
        <label class="field-label" for="checklist-label-input">Label</label>
        <input type="text" id="checklist-label-input" placeholder="e.g. Remove trash from vehicle" value="${escapeHtml(
          item?.label ?? '',
        )}" />
      </div>
      <button type="button" class="btn btn-primary" id="checklist-save-btn">${
        isEdit ? 'Save Changes' : 'Add Item'
      }</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const saveBtn = sheet.querySelector('#checklist-save-btn');
  saveBtn.addEventListener('click', async () => {
    const label = sheet.querySelector('#checklist-label-input').value.trim();
    if (!label) {
      showError('Label is required.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (isEdit) await updateChecklistItem(item.id, { label });
      else await createChecklistItem(label, nextSortOrder);
      closeModal();
      showSuccess(isEdit ? 'Checklist item updated.' : 'Checklist item added.');
      await renderChecklistItems();
    } catch (err) {
      showError(err.message || 'Could not save this item. Try again.');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Item';
    }
  });
}

async function renderChecklistItems() {
  const container = document.getElementById('section-checklist');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const items = await fetchAllChecklistItems();
    const active = items.filter((i) => i.active);

    const rows = items
      .map((item) => {
        const activeIndex = active.findIndex((a) => a.id === item.id);
        const atTop = activeIndex === 0;
        const atBottom = activeIndex === active.length - 1;
        return `
          <tr class="${item.active ? '' : 'is-inactive'}">
            <td>${item.active ? activeIndex + 1 : '—'}</td>
            <td class="cell-wrap"><strong>${escapeHtml(item.label)}</strong></td>
            <td><span class="badge ${item.active ? 'badge-good' : 'badge-muted'}">${
              item.active ? 'Active' : 'Retired'
            }</span></td>
            <td>
              <div class="row-actions">
                ${
                  item.active
                    ? `<button type="button" class="btn btn-secondary btn-sm move-item-btn" data-item-id="${escapeHtml(
                        item.id,
                      )}" data-dir="-1" ${atTop ? 'disabled' : ''} aria-label="Move up">&uarr;</button>
                       <button type="button" class="btn btn-secondary btn-sm move-item-btn" data-item-id="${escapeHtml(
                         item.id,
                       )}" data-dir="1" ${atBottom ? 'disabled' : ''} aria-label="Move down">&darr;</button>`
                    : ''
                }
                <button type="button" class="btn btn-secondary btn-sm edit-item-btn" data-item-id="${escapeHtml(
                  item.id,
                )}">Edit</button>
                <button type="button" class="btn btn-secondary btn-sm toggle-item-btn" data-item-id="${escapeHtml(
                  item.id,
                )}">${item.active ? 'Retire' : 'Restore'}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="section-toolbar">
        <h2 class="section-title">Return Checklist</h2>
        <button type="button" class="btn btn-primary btn-auto" id="add-checklist-btn">+ Add Item</button>
      </div>
      <p class="section-hint">
        Drivers tick every active item, in this order, before they can sign out.
        Retiring an item hides it from new returns but keeps old returns readable.
      </p>
      ${
        active.length === 0
          ? '<p class="section-warning">No active items — drivers will sign out without a checklist.</p>'
          : ''
      }
      <div class="table-scroll">
        <table>
          <thead><tr><th>#</th><th>Item</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">No checklist items yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    const nextSortOrder = items.length + 1;
    container
      .querySelector('#add-checklist-btn')
      .addEventListener('click', () => openChecklistItemModal(null, nextSortOrder));

    container.querySelectorAll('.edit-item-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openChecklistItemModal(items.find((i) => i.id === btn.dataset.itemId));
      });
    });

    container.querySelectorAll('.toggle-item-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = items.find((i) => i.id === btn.dataset.itemId);
        btn.disabled = true;
        try {
          await setChecklistItemActive(item.id, !item.active);
          await renderChecklistItems();
        } catch (err) {
          showError(err.message || 'Could not update this item. Try again.');
          btn.disabled = false;
        }
      });
    });

    container.querySelectorAll('.move-item-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const from = active.findIndex((a) => a.id === btn.dataset.itemId);
        const to = from + Number(btn.dataset.dir);
        if (from < 0 || to < 0 || to >= active.length) return;

        const reordered = [...active];
        const [moved] = reordered.splice(from, 1);
        reordered.splice(to, 0, moved);

        container.querySelectorAll('.move-item-btn').forEach((b) => {
          b.disabled = true;
        });
        try {
          await reorderChecklistItems(reordered.map((i) => i.id));
        } catch (err) {
          showError(err.message || 'Could not reorder the checklist. Try again.');
        }
        // Re-render either way: a partial reorder must not leave the screen
        // showing an order the database doesn't actually have.
        await renderChecklistItems();
      });
    });
  } catch {
    showError('Could not load the return checklist.');
    container.innerHTML = '<p class="empty-state">Could not load the return checklist.</p>';
  }
}

// ---------------------------------------------------------------------------
// driver incidents (customer complaints, full CRUD + resolve)
// ---------------------------------------------------------------------------
function openDriverIncidentModal(incident = null, drivers = []) {
  const isEdit = Boolean(incident);
  const sheet = openModal(
    isEdit ? 'Edit incident' : 'Add an incident',
    `
      <h2>${isEdit ? 'Edit Incident' : 'Add Incident'}</h2>
      <div>
        <label class="field-label" for="incident-driver-select">Driver</label>
        <select id="incident-driver-select">
          <option value="">Select…</option>
          ${drivers
            .map(
              (d) =>
                `<option value="${escapeHtml(d.id)}" ${
                  incident?.driver_id === d.id ? 'selected' : ''
                }>${escapeHtml(d.name)}</option>`,
            )
            .join('')}
        </select>
      </div>
      <div>
        <label class="field-label" for="incident-customer-input">Customer Name</label>
        <input type="text" id="incident-customer-input" placeholder="Optional" value="${escapeHtml(
          incident?.customer_name ?? '',
        )}" />
      </div>
      <div>
        <label class="field-label" for="incident-description-input">What happened</label>
        <textarea id="incident-description-input" placeholder="Complaint details">${escapeHtml(
          incident?.description ?? '',
        )}</textarea>
      </div>
      <div>
        <label class="field-label" for="incident-resolution-input">Resolution Notes</label>
        <textarea id="incident-resolution-input" placeholder="Optional">${escapeHtml(
          incident?.resolution_notes ?? '',
        )}</textarea>
      </div>
      <button type="button" class="btn btn-primary" id="incident-save-btn">${
        isEdit ? 'Save Changes' : 'Add Incident'
      }</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const saveBtn = sheet.querySelector('#incident-save-btn');
  saveBtn.addEventListener('click', async () => {
    const driverId = sheet.querySelector('#incident-driver-select').value;
    const description = sheet.querySelector('#incident-description-input').value.trim();
    if (!driverId) {
      showError('Driver is required.');
      return;
    }
    if (!description) {
      showError('Description is required.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const customerName = sheet.querySelector('#incident-customer-input').value.trim();
      const resolutionNotes = sheet.querySelector('#incident-resolution-input').value.trim();
      if (isEdit) {
        await updateDriverIncident(incident.id, {
          driver_id: driverId,
          customer_name: customerName,
          description,
          resolution_notes: resolutionNotes,
        });
      } else {
        await createDriverIncident(driverId, customerName, description);
      }
      closeModal();
      showSuccess(isEdit ? 'Incident updated.' : 'Incident logged.');
      await renderDriverIncidents();
    } catch (err) {
      showError(err.message || 'Could not save this incident. Try again.');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Incident';
    }
  });
}

async function renderDriverIncidents() {
  const container = document.getElementById('section-incidents');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const [incidents, drivers] = await Promise.all([fetchDriverIncidents(), fetchAllDrivers()]);

    const rows = incidents
      .map(
        (i) => `
          <tr>
            <td><strong>${escapeHtml(i.drivers?.name ?? '—')}</strong></td>
            <td>${escapeHtml(i.customer_name ?? '—')}</td>
            <td class="cell-wrap">${escapeHtml(i.description)}</td>
            <td><span class="badge ${i.status === 'open' ? 'badge-warn' : 'badge-good'}">${escapeHtml(
              i.status,
            )}</span></td>
            <td>${formatDateTime(i.reported_at)}</td>
            <td>
              <div class="row-actions">
                <button type="button" class="btn btn-secondary btn-sm edit-incident-btn" data-incident-id="${escapeHtml(
                  i.id,
                )}">Edit</button>
                <button type="button" class="btn btn-secondary btn-sm toggle-incident-btn" data-incident-id="${escapeHtml(
                  i.id,
                )}">${i.status === 'open' ? 'Resolve' : 'Reopen'}</button>
              </div>
            </td>
          </tr>
        `,
      )
      .join('');

    container.innerHTML = `
      <div class="section-toolbar">
        <h2 class="section-title">Driver Incidents</h2>
        <button type="button" class="btn btn-primary btn-auto" id="add-incident-btn">+ Add Incident</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Driver</th><th>Customer</th><th>Description</th><th>Status</th><th>Reported</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">No incidents reported yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    container
      .querySelector('#add-incident-btn')
      .addEventListener('click', () => openDriverIncidentModal(null, drivers));

    container.querySelectorAll('.edit-incident-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openDriverIncidentModal(
          incidents.find((i) => i.id === btn.dataset.incidentId),
          drivers,
        );
      });
    });

    container.querySelectorAll('.toggle-incident-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const incident = incidents.find((i) => i.id === btn.dataset.incidentId);
        btn.disabled = true;
        try {
          await setDriverIncidentStatus(incident.id, incident.status === 'open');
          await renderDriverIncidents();
        } catch (err) {
          showError(err.message || 'Could not update this incident. Try again.');
          btn.disabled = false;
        }
      });
    });
  } catch {
    showError('Could not load driver incidents.');
    container.innerHTML = '<p class="empty-state">Could not load driver incidents.</p>';
  }
}

// ---------------------------------------------------------------------------
// hot bags (full CRUD + maintenance history)
// ---------------------------------------------------------------------------
function openHotBagModal(bag = null) {
  const isEdit = Boolean(bag);
  const sheet = openModal(
    isEdit ? `Edit ${bag.name}` : 'Add a hot bag',
    `
      <h2>${isEdit ? 'Edit Hot Bag' : 'Add Hot Bag'}</h2>
      <div>
        <label class="field-label" for="hotbag-name-input">Name</label>
        <input type="text" id="hotbag-name-input" placeholder="e.g. Hot Bag 05" value="${escapeHtml(
          bag?.name ?? '',
        )}" />
      </div>
      <div>
        <label class="field-label" for="hotbag-window-input">Needs cleaning after (days)</label>
        <input type="number" min="1" id="hotbag-window-input" value="${escapeHtml(
          String(bag?.clean_window_days ?? HOT_BAG_CLEAN_WINDOW_DAYS),
        )}" />
      </div>
      <button type="button" class="btn btn-primary" id="hotbag-save-btn">${
        isEdit ? 'Save Changes' : 'Add Hot Bag'
      }</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const saveBtn = sheet.querySelector('#hotbag-save-btn');
  saveBtn.addEventListener('click', async () => {
    const name = sheet.querySelector('#hotbag-name-input').value.trim();
    const windowDays = parseInt(sheet.querySelector('#hotbag-window-input').value, 10);
    if (!name) {
      showError('Name is required.');
      return;
    }
    if (!Number.isFinite(windowDays) || windowDays < 1) {
      showError('Cleaning window must be at least 1 day.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (isEdit) await updateHotBag(bag.id, { name, clean_window_days: windowDays });
      else await createHotBag(name, windowDays);
      closeModal();
      showSuccess(isEdit ? 'Hot bag updated.' : `${name} added.`);
      await renderHotBagsAdmin();
    } catch (err) {
      showError(err.message || 'Could not save this hot bag. Try again.');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Hot Bag';
    }
  });
}

async function renderHotBagsAdmin() {
  const container = document.getElementById('section-hotbags');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const [bags, maintenance] = await Promise.all([fetchAllHotBags(), fetchHotBagMaintenanceHistory()]);

    const openIssuesByBag = new Map();
    maintenance
      .filter((m) => m.status === 'open')
      .forEach((m) => openIssuesByBag.set(m.bag_id, (openIssuesByBag.get(m.bag_id) || 0) + 1));

    const bagRows = bags
      .map((bag) => {
        const needsCleaning = isNeedsCleaning(bag);
        const openCount = openIssuesByBag.get(bag.id) || 0;
        const badge = !bag.active ? 'badge-muted' : needsCleaning ? 'badge-warn' : 'badge-good';
        const label = !bag.active ? 'Inactive' : needsCleaning ? 'Needs Cleaning' : 'Current';
        return `
          <tr class="${bag.active ? '' : 'is-inactive'}">
            <td><strong>${escapeHtml(bag.name)}</strong></td>
            <td>${formatDate(bag.last_cleaned, 'Never')}</td>
            <td>${escapeHtml(String(bag.clean_window_days ?? HOT_BAG_CLEAN_WINDOW_DAYS))} days</td>
            <td><span class="badge ${badge}">${label}</span></td>
            <td>${openCount}</td>
            <td>
              <div class="row-actions">
                <button type="button" class="btn btn-secondary btn-sm edit-bag-btn" data-bag-id="${escapeHtml(
                  bag.id,
                )}">Edit</button>
                <button type="button" class="btn btn-secondary btn-sm toggle-bag-btn" data-bag-id="${escapeHtml(
                  bag.id,
                )}">${bag.active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    const maintenanceRows = maintenance
      .map(
        (m) => `
          <tr>
            <td><strong>${escapeHtml(m.hot_bags?.name ?? '—')}</strong></td>
            <td>${escapeHtml(m.issue)}</td>
            <td class="cell-wrap">${escapeHtml(m.notes ?? '—')}</td>
            <td><span class="badge ${m.status === 'open' ? 'badge-warn' : 'badge-good'}">${escapeHtml(
              m.status,
            )}</span></td>
            <td>${formatDateTime(m.submitted_at)}</td>
          </tr>
        `,
      )
      .join('');

    container.innerHTML = `
      <div class="section-toolbar">
        <h2 class="section-title">Hot Bags</h2>
        <button type="button" class="btn btn-primary btn-auto" id="add-hotbag-btn">+ Add Hot Bag</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Bag</th><th>Last Cleaned</th><th>Clean Window</th><th>Status</th><th>Open Issues</th><th>Actions</th></tr></thead>
          <tbody>${bagRows || '<tr><td colspan="6">No hot bags configured.</td></tr>'}</tbody>
        </table>
      </div>
      <h2 class="section-title">Maintenance History</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Bag</th><th>Issue</th><th>Notes</th><th>Status</th><th>Submitted</th></tr></thead>
          <tbody>${maintenanceRows || '<tr><td colspan="5">No maintenance reports yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    container.querySelector('#add-hotbag-btn').addEventListener('click', () => openHotBagModal());

    container.querySelectorAll('.edit-bag-btn').forEach((btn) => {
      btn.addEventListener('click', () => openHotBagModal(bags.find((b) => b.id === btn.dataset.bagId)));
    });

    container.querySelectorAll('.toggle-bag-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bag = bags.find((b) => b.id === btn.dataset.bagId);
        btn.disabled = true;
        try {
          await setHotBagActive(bag.id, !bag.active);
          await renderHotBagsAdmin();
        } catch (err) {
          showError(err.message || 'Could not update this hot bag. Try again.');
          btn.disabled = false;
        }
      });
    });
  } catch {
    showError('Could not load hot bag data.');
    container.innerHTML = '<p class="empty-state">Could not load hot bag data.</p>';
  }
}

// ---------------------------------------------------------------------------
// slow tasks (full CRUD + completion history)
// ---------------------------------------------------------------------------
function openSlowTaskModal(task = null) {
  const isEdit = Boolean(task);
  const sheet = openModal(
    isEdit ? `Edit ${task.name}` : 'Add a slow task',
    `
      <h2>${isEdit ? 'Edit Slow Task' : 'Add Slow Task'}</h2>
      <div>
        <label class="field-label" for="task-name-input">Name</label>
        <input type="text" id="task-name-input" placeholder="Task name" value="${escapeHtml(task?.name ?? '')}" />
      </div>
      <div>
        <label class="field-label" for="task-description-input">Description</label>
        <textarea id="task-description-input" placeholder="Optional">${escapeHtml(
          task?.description ?? '',
        )}</textarea>
      </div>
      <div>
        <label class="field-label" for="task-frequency-input">Recurs every (days)</label>
        <input type="number" min="1" id="task-frequency-input" value="${escapeHtml(
          String(task?.frequency_days ?? ''),
        )}" />
      </div>
      <button type="button" class="btn btn-primary" id="task-save-btn">${
        isEdit ? 'Save Changes' : 'Add Task'
      }</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const saveBtn = sheet.querySelector('#task-save-btn');
  saveBtn.addEventListener('click', async () => {
    const name = sheet.querySelector('#task-name-input').value.trim();
    const frequencyDays = parseInt(sheet.querySelector('#task-frequency-input').value, 10);
    if (!name) {
      showError('Name is required.');
      return;
    }
    if (!Number.isFinite(frequencyDays) || frequencyDays < 1) {
      showError('Frequency must be at least 1 day.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const description = sheet.querySelector('#task-description-input').value.trim();
      if (isEdit) await updateSlowTask(task.id, { name, description, frequency_days: frequencyDays });
      else await createSlowTask(name, description, frequencyDays);
      closeModal();
      showSuccess(isEdit ? 'Task updated.' : `${name} added.`);
      await renderSlowTasksAdmin();
    } catch (err) {
      showError(err.message || 'Could not save this task. Try again.');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Task';
    }
  });
}

async function renderSlowTasksAdmin() {
  const container = document.getElementById('section-slowtasks');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const tasks = await fetchAllSlowTasks();
    const rows = tasks
      .map((t) => {
        const due = t.active && isTaskDue(t);
        const badge = !t.active ? 'badge-muted' : due ? 'badge-warn' : 'badge-good';
        const label = !t.active ? 'Inactive' : due ? 'Due' : 'On Track';
        return `
          <tr class="clickable ${t.active ? '' : 'is-inactive'}" data-task-id="${escapeHtml(t.id)}">
            <td><strong>${escapeHtml(t.name)}</strong></td>
            <td>${frequencyLabel(t.frequency_days)}</td>
            <td>${formatDate(t.last_completed, 'Never')}</td>
            <td>${formatDate(t.next_due)}</td>
            <td><span class="badge ${badge}">${label}</span></td>
            <td>
              <div class="row-actions">
                <button type="button" class="btn btn-secondary btn-sm edit-task-btn" data-task-id="${escapeHtml(
                  t.id,
                )}">Edit</button>
                <button type="button" class="btn btn-secondary btn-sm toggle-task-btn" data-task-id="${escapeHtml(
                  t.id,
                )}">${t.active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="section-toolbar">
        <h2 class="section-title">Slow Tasks</h2>
        <button type="button" class="btn btn-primary btn-auto" id="add-task-btn">+ Add Slow Task</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Task</th><th>Frequency</th><th>Last Completed</th><th>Next Due</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6">No slow tasks configured.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    container.querySelector('#add-task-btn').addEventListener('click', () => openSlowTaskModal());

    container.querySelectorAll('tr[data-task-id]').forEach((row) => {
      row.addEventListener('click', (event) => {
        if (event.target.closest('.row-actions')) return;
        showSlowTaskDetail(tasks.find((t) => t.id === row.dataset.taskId));
      });
    });

    container.querySelectorAll('.edit-task-btn').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        openSlowTaskModal(tasks.find((t) => t.id === btn.dataset.taskId));
      });
    });

    container.querySelectorAll('.toggle-task-btn').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const task = tasks.find((t) => t.id === btn.dataset.taskId);
        btn.disabled = true;
        try {
          await setSlowTaskActive(task.id, !task.active);
          await renderSlowTasksAdmin();
        } catch (err) {
          showError(err.message || 'Could not update this task. Try again.');
          btn.disabled = false;
        }
      });
    });
  } catch {
    showError('Could not load slow tasks.');
    container.innerHTML = '<p class="empty-state">Could not load slow tasks.</p>';
  }
}

async function showSlowTaskDetail(task) {
  showSection('slowtask-detail');
  const container = document.getElementById('section-slowtask-detail');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const completions = await fetchSlowTaskCompletions(task.id);
    const rows = completions
      .map(
        (c) => `
          <tr>
            <td>${formatDateTime(c.completed_at)}</td>
            <td>${escapeHtml(c.drivers?.name ?? 'Not specified')}</td>
            <td class="cell-wrap">${escapeHtml(c.notes ?? '—')}</td>
          </tr>
        `,
      )
      .join('');

    container.innerHTML = `
      <button type="button" class="back-link" id="slowtask-detail-back">‹ Back to slow tasks</button>
      <h2 class="section-title">${escapeHtml(task.name)} — Completion History</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Completed</th><th>By</th><th>Notes</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3">No completions recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
    container
      .querySelector('#slowtask-detail-back')
      .addEventListener('click', () => switchSection('slowtasks'));
  } catch {
    showError('Could not load completion history.');
    container.innerHTML = '<p class="empty-state">Could not load completion history.</p>';
  }
}

// ---------------------------------------------------------------------------
// section switching
// ---------------------------------------------------------------------------
const RENDERERS = {
  dashboard: renderDashboard,
  vehicles: renderVehicles,
  drivers: renderDrivers,
  'driver-history': renderDriverHistory,
  checklist: renderChecklistItems,
  incidents: renderDriverIncidents,
  hotbags: renderHotBagsAdmin,
  slowtasks: renderSlowTasksAdmin,
};

function showSection(key) {
  document.querySelectorAll('.admin-section').forEach((el) => el.classList.add('hidden'));
  document.getElementById(`section-${key}`).classList.remove('hidden');
  window.scrollTo(0, 0);
}

function switchSection(key) {
  showSection(key);
  document.querySelectorAll('#admin-nav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === key);
  });
  RENDERERS[key]?.();
}

document.getElementById('admin-nav').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-section]');
  if (btn) switchSection(btn.dataset.section);
});

// ---------------------------------------------------------------------------
// PIN lock screen — casual deterrent only, not real auth (see config.js)
// ---------------------------------------------------------------------------
const LOCK_STORAGE_KEY = 'pitcrew_admin_unlocked';

function unlockAdmin() {
  document.getElementById('lock-overlay').remove();
  document.getElementById('admin-app').classList.remove('hidden');
  switchSection('dashboard');
}

function initLockScreen() {
  if (sessionStorage.getItem(LOCK_STORAGE_KEY) === 'true') {
    unlockAdmin();
    return;
  }

  const pinInput = document.getElementById('lock-pin-input');
  const submitBtn = document.getElementById('lock-submit-btn');
  const errorEl = document.getElementById('lock-error');

  function attemptUnlock() {
    if (pinInput.value === ADMIN_PIN) {
      sessionStorage.setItem(LOCK_STORAGE_KEY, 'true');
      unlockAdmin();
    } else {
      errorEl.classList.remove('hidden');
      pinInput.value = '';
      pinInput.focus();
    }
  }

  submitBtn.addEventListener('click', attemptUnlock);
  pinInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attemptUnlock();
  });
  pinInput.focus();
}

initOfflineBanner();
startTicker();
initLockScreen();
