import {
  fetchVehiclesWithAvailability,
  createVehicle,
  updateVehicle,
  setVehicleStatus,
  setVehicleActive,
  VEHICLE_STATUSES,
  fetchOpenSessions,
  forceCloseSession,
  fetchAllDrivers,
  createDriver,
  updateDriver,
  setDriverActive,
  fetchDriverIncidents,
  fetchOpenDriverIncidents,
  createDriverIncident,
  updateDriverIncident,
  setDriverIncidentStatus,
  fetchHotBags,
  fetchAllHotBags,
  createHotBag,
  updateHotBag,
  setHotBagActive,
  fetchHotBagMaintenanceHistory,
  fetchOpenHotBagIssues,
  setHotBagIssueStatus,
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
  safeHex,
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
import {
  badge,
  sectionHint,
  sectionWarning,
  sectionToolbar,
  actionButton,
  backLink,
  dataTable,
  rowActions,
  field,
  textInput,
  colorInput,
  numberInput,
  textArea,
  select,
  modalActions,
} from './render.js';

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
    // Both open-row reads rather than the capped history reads: these tiles are
    // counts, and counting a truncated list undercounts once history outgrows
    // HISTORY_PAGE_SIZE. driver_incidents stays best-effort so the dashboard
    // still renders on a project whose schema migration hasn't been applied.
    const [vehicles, openSessions, hotBags, openBagIssues, slowTasks, openIncidents_] = await Promise.all([
      fetchVehiclesWithAvailability(),
      fetchOpenSessions(),
      fetchHotBags(),
      fetchOpenHotBagIssues(),
      fetchSlowTasks(),
      fetchOpenDriverIncidents().catch(() => []),
    ]);

    const out = vehicles.filter((v) => v.activeSession).length;
    const free = vehicles.filter((v) => !v.activeSession && v.status !== 'out_of_service').length;
    const needsCleaning = hotBags.filter(isNeedsCleaning).length;
    const dueTasks = slowTasks.filter(isTaskDue).length;
    const openIssues = openBagIssues.length;
    const openIncidents = openIncidents_.length;

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
            <td>${overdue ? badge('Overdue', 'warn') : badge('On shift', 'neutral')}</td>
            <td>${
              overdue
                ? rowActions([
                    { label: 'Force Close', className: 'force-close-btn', data: { 'data-session-id': s.id } },
                  ])
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

      ${sectionToolbar(
        'On Shift Right Now',
        overdueSessions.length
          ? sectionHint(`${overdueSessions.length} past ${SHIFT_OVERDUE_HOURS}h without signing out.`)
          : '',
      )}
      ${dataTable({
        columns: ['Driver', 'Vehicle', 'Started', 'Elapsed', 'State', ''],
        rows: shiftRows,
        empty: 'Nobody is out right now.',
      })}
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
      ${field('Note saved to history', 'force-close-note', textArea({ id: 'force-close-note', value: defaultNote }))}
      ${modalActions('Force Close Shift', 'force-close-confirm')}
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
function vehicleStatusBadge(vehicle) {
  if (!vehicle.active) return badge('Retired', 'muted');
  if (vehicle.activeSession) return badge('In Use', 'neutral');
  if (vehicle.status === 'available') return badge('Available', 'good');
  if (vehicle.status === 'needs_attention') return badge('Needs Attention', 'warn');
  return badge('Out of Service', 'bad');
}

function openVehicleModal(vehicle = null) {
  const isEdit = Boolean(vehicle);
  const sheet = openModal(
    isEdit ? `Edit ${vehicle.name}` : 'Add a vehicle',
    `
      <h2>${isEdit ? 'Edit Vehicle' : 'Add Vehicle'}</h2>
      ${field(
        'Name',
        'vehicle-name-input',
        textInput({ id: 'vehicle-name-input', placeholder: 'e.g. Green Car', value: vehicle?.name ?? '' }),
      )}
      ${field(
        'Colour name',
        'vehicle-colorname-input',
        textInput({
          id: 'vehicle-colorname-input',
          placeholder: 'e.g. Green',
          value: vehicle?.color_name ?? '',
        }),
      )}
      ${field(
        'Colour on the board',
        'vehicle-colorhex-input',
        colorInput({ id: 'vehicle-colorhex-input', value: vehicle?.color_hex ?? '#2f8f4e' }),
      )}
      ${field(
        'Status',
        'vehicle-status-select',
        select({
          id: 'vehicle-status-select',
          options: VEHICLE_STATUSES.map((s) => ({
            value: s.value,
            label: s.label,
            selected: (vehicle?.status ?? 'available') === s.value,
          })),
        }),
      )}
      <p class="meta">
        Status is the vehicle's condition. Whether it is checked out right now is
        separate and works itself out from the driving sessions.
      </p>
      ${modalActions(isEdit ? 'Save Changes' : 'Add Vehicle', 'vehicle-save-btn')}
    `,
  );

  const saveBtn = sheet.querySelector('#vehicle-save-btn');
  saveBtn.addEventListener('click', async () => {
    const name = sheet.querySelector('#vehicle-name-input').value.trim();
    const colorName = sheet.querySelector('#vehicle-colorname-input').value.trim();
    if (!name) {
      showError('Name is required.');
      return;
    }
    if (!colorName) {
      showError('Colour name is required.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const payload = {
        name,
        color_name: colorName,
        color_hex: sheet.querySelector('#vehicle-colorhex-input').value,
        status: sheet.querySelector('#vehicle-status-select').value,
      };
      if (isEdit) await updateVehicle(vehicle.id, payload);
      else await createVehicle(payload);
      closeModal();
      showSuccess(isEdit ? 'Vehicle updated.' : `${name} added.`);
      await renderVehicles();
    } catch (err) {
      showError(err.message || 'Could not save this vehicle. Try again.');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Vehicle';
    }
  });
}

async function renderVehicles() {
  const container = document.getElementById('section-vehicles');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const vehicles = await fetchVehiclesWithAvailability({ includeInactive: true });
    const rows = vehicles
      .map((v) => {
        const offRoad = v.status === 'out_of_service';
        return `
          <tr class="clickable ${v.active ? '' : 'is-inactive'}" data-vehicle-id="${escapeHtml(v.id)}">
            <td><strong>${escapeHtml(v.name)}</strong></td>
            <td>
              <span class="color-chip" style="background:${escapeHtml(safeHex(v.color_hex))}"></span>
              ${escapeHtml(v.color_name)}
            </td>
            <td>${vehicleStatusBadge(v)}</td>
            <td>${v.activeSession ? escapeHtml(v.activeSession.drivers?.name ?? '—') : '—'}</td>
            <td>${v.activeSession ? formatDateTime(v.activeSession.start_time) : '—'}</td>
            <td>${
              v.activeSession
                ? `<span class="elapsed" data-since="${escapeHtml(v.activeSession.start_time)}">—</span>`
                : '—'
            }</td>
            <td>${rowActions([
              { label: 'Edit', className: 'edit-vehicle-btn', data: { 'data-vehicle-id': v.id } },
              // The urgent path gets its own one-tap button. A car comes off the
              // road mid-shift on a Saturday, not at a desk with time to open a
              // modal — "Needs Attention" is the nuanced case and lives in Edit.
              v.active && {
                label: offRoad ? 'Return to service' : 'Take off road',
                className: 'road-vehicle-btn',
                data: { 'data-vehicle-id': v.id, 'data-to': offRoad ? 'available' : 'out_of_service' },
              },
              {
                label: v.active ? 'Retire' : 'Restore',
                className: 'toggle-vehicle-btn',
                data: { 'data-vehicle-id': v.id },
              },
            ])}</td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      ${sectionToolbar('Vehicles', actionButton('+ Add Vehicle', 'add-vehicle-btn'))}
      ${sectionHint('Tap a row for its full driving history. Retiring keeps the history and takes it off the kiosk.')}
      ${dataTable({
        columns: ['Vehicle', 'Color', 'Status', 'Current Driver', 'Shift Started', 'Elapsed', 'Actions'],
        rows,
        empty: 'No vehicles configured.',
      })}
    `;

    container.querySelector('#add-vehicle-btn').addEventListener('click', () => openVehicleModal());

    container.querySelectorAll('tr[data-vehicle-id]').forEach((row) => {
      row.addEventListener('click', (event) => {
        if (event.target.closest('.row-actions')) return;
        showVehicleDetail(vehicles.find((v) => v.id === row.dataset.vehicleId));
      });
    });

    container.querySelectorAll('.edit-vehicle-btn').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        openVehicleModal(vehicles.find((v) => v.id === btn.dataset.vehicleId));
      });
    });

    container.querySelectorAll('.road-vehicle-btn').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        try {
          await setVehicleStatus(btn.dataset.vehicleId, btn.dataset.to);
          await renderVehicles();
        } catch (err) {
          showError(err.message || 'Could not update this vehicle. Try again.');
          btn.disabled = false;
        }
      });
    });

    container.querySelectorAll('.toggle-vehicle-btn').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const vehicle = vehicles.find((v) => v.id === btn.dataset.vehicleId);
        btn.disabled = true;
        try {
          await setVehicleActive(vehicle.id, !vehicle.active);
          await renderVehicles();
        } catch (err) {
          showError(err.message || 'Could not update this vehicle. Try again.');
          btn.disabled = false;
        }
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
      ${backLink('‹ Back to vehicles', 'vehicle-detail-back')}
      <h2 class="section-title">${escapeHtml(vehicle.name)} — Driving History</h2>
      ${
        history.length >= HISTORY_PAGE_SIZE
          ? sectionHint(`Showing the ${HISTORY_PAGE_SIZE} most recent shifts.`)
          : ''
      }
      ${dataTable({
        columns: ['Driver', 'Start', 'End', 'Checklist', 'Notes'],
        rows,
        empty: 'No driving history yet.',
      })}
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
      ${field(
        'Name',
        'driver-name-input',
        textInput({ id: 'driver-name-input', placeholder: 'Full name', value: driver?.name ?? '' }),
      )}
      ${field(
        'Employee Number',
        'driver-employee-input',
        textInput({
          id: 'driver-employee-input',
          placeholder: 'Optional',
          value: driver?.employee_number ?? '',
        }),
      )}
      ${modalActions(isEdit ? 'Save Changes' : 'Add Driver', 'driver-save-btn')}
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
    // Open rows only — a count derived from the capped history read goes stale
    // low. Best-effort: the Drivers tab still works even if driver_incidents
    // isn't there yet (e.g. schema migration not applied) — it just shows 0
    // open incidents everywhere instead of failing the whole section.
    const openIncidents = await fetchOpenDriverIncidents().catch(() => []);

    const openByDriver = new Map();
    openIncidents.forEach((i) => openByDriver.set(i.driver_id, (openByDriver.get(i.driver_id) || 0) + 1));

    const rows = drivers
      .map((d) => {
        const openCount = openByDriver.get(d.id) || 0;
        return `
          <tr class="${d.active ? '' : 'is-inactive'}">
            <td><strong>${escapeHtml(d.name)}</strong></td>
            <td>${escapeHtml(d.employee_number ?? '—')}</td>
            <td>${d.active ? badge('Active', 'good') : badge('Inactive', 'muted')}</td>
            <td>${openCount > 0 ? badge(openCount, 'warn') : '0'}</td>
            <td>${rowActions([
              { label: 'Edit', className: 'edit-driver-btn', data: { 'data-driver-id': d.id } },
              {
                label: d.active ? 'Deactivate' : 'Reactivate',
                className: 'toggle-driver-btn',
                data: { 'data-driver-id': d.id },
              },
            ])}</td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      ${sectionToolbar('Drivers', actionButton('+ Add Driver', 'add-driver-btn'))}
      ${dataTable({
        columns: ['Name', 'Employee #', 'Status', 'Open Incidents', 'Actions'],
        rows,
        empty: 'No drivers yet.',
      })}
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
            <td>${s.end_time ? badge('Closed', 'good') : badge('Open', 'neutral')}</td>
            <td>${s.checklist_completed ? 'Yes' : 'No'}</td>
            <td>${escapeHtml(s.return_notes ?? '—')}</td>
          </tr>
        `,
      )
      .join('');

    const truncated = sessions.length >= HISTORY_PAGE_SIZE;
    container.innerHTML = `
      ${sectionToolbar(
        'Driver History',
        truncated ? sectionHint(`Showing the ${HISTORY_PAGE_SIZE} most recent shifts.`) : '',
      )}
      ${dataTable({
        columns: ['Driver', 'Vehicle', 'Start', 'End', 'Shift', 'Checklist', 'Notes'],
        rows,
        empty: 'No driving history yet.',
      })}
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
      ${field(
        'Label',
        'checklist-label-input',
        textInput({
          id: 'checklist-label-input',
          placeholder: 'e.g. Remove trash from vehicle',
          value: item?.label ?? '',
        }),
      )}
      ${modalActions(isEdit ? 'Save Changes' : 'Add Item', 'checklist-save-btn')}
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
            <td>${item.active ? badge('Active', 'good') : badge('Retired', 'muted')}</td>
            <td>${rowActions([
              item.active && {
                label: '↑',
                className: 'move-item-btn',
                data: { 'data-item-id': item.id, 'data-dir': '-1' },
                disabled: atTop,
                ariaLabel: 'Move up',
              },
              item.active && {
                label: '↓',
                className: 'move-item-btn',
                data: { 'data-item-id': item.id, 'data-dir': '1' },
                disabled: atBottom,
                ariaLabel: 'Move down',
              },
              { label: 'Edit', className: 'edit-item-btn', data: { 'data-item-id': item.id } },
              {
                label: item.active ? 'Retire' : 'Restore',
                className: 'toggle-item-btn',
                data: { 'data-item-id': item.id },
              },
            ])}</td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      ${sectionToolbar('Return Checklist', actionButton('+ Add Item', 'add-checklist-btn'))}
      ${sectionHint(
        'Drivers tick every active item, in this order, before they can sign out. ' +
          'Retiring an item hides it from new returns but keeps old returns readable.',
      )}
      ${
        active.length === 0
          ? sectionWarning('No active items — drivers will sign out without a checklist.')
          : ''
      }
      ${dataTable({
        columns: ['#', 'Item', 'Status', 'Actions'],
        rows,
        empty: 'No checklist items yet.',
      })}
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
      ${field(
        'Driver',
        'incident-driver-select',
        select({
          id: 'incident-driver-select',
          placeholder: 'Select…',
          options: drivers.map((d) => ({
            value: d.id,
            label: d.name,
            selected: incident?.driver_id === d.id,
          })),
        }),
      )}
      ${field(
        'Customer Name',
        'incident-customer-input',
        textInput({
          id: 'incident-customer-input',
          placeholder: 'Optional',
          value: incident?.customer_name ?? '',
        }),
      )}
      ${field(
        'What happened',
        'incident-description-input',
        textArea({
          id: 'incident-description-input',
          placeholder: 'Complaint details',
          value: incident?.description ?? '',
        }),
      )}
      ${field(
        'Resolution Notes',
        'incident-resolution-input',
        textArea({
          id: 'incident-resolution-input',
          placeholder: 'Optional',
          value: incident?.resolution_notes ?? '',
        }),
      )}
      ${modalActions(isEdit ? 'Save Changes' : 'Add Incident', 'incident-save-btn')}
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
            <td>${badge(i.status, i.status === 'open' ? 'warn' : 'good')}</td>
            <td>${formatDateTime(i.reported_at)}</td>
            <td>${rowActions([
              { label: 'Edit', className: 'edit-incident-btn', data: { 'data-incident-id': i.id } },
              {
                label: i.status === 'open' ? 'Resolve' : 'Reopen',
                className: 'toggle-incident-btn',
                data: { 'data-incident-id': i.id },
              },
            ])}</td>
          </tr>
        `,
      )
      .join('');

    container.innerHTML = `
      ${sectionToolbar('Driver Incidents', actionButton('+ Add Incident', 'add-incident-btn'))}
      ${
        incidents.length >= HISTORY_PAGE_SIZE
          ? sectionHint(
              `Showing the ${HISTORY_PAGE_SIZE} most recent incidents. Open ones are always counted in full.`,
            )
          : ''
      }
      ${dataTable({
        columns: ['Driver', 'Customer', 'Description', 'Status', 'Reported', 'Actions'],
        rows,
        empty: 'No incidents reported yet.',
      })}
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
      ${field(
        'Name',
        'hotbag-name-input',
        textInput({ id: 'hotbag-name-input', placeholder: 'e.g. Hot Bag 05', value: bag?.name ?? '' }),
      )}
      ${field(
        'Needs cleaning after (days)',
        'hotbag-window-input',
        numberInput({
          id: 'hotbag-window-input',
          min: 1,
          value: bag?.clean_window_days ?? HOT_BAG_CLEAN_WINDOW_DAYS,
        }),
      )}
      ${modalActions(isEdit ? 'Save Changes' : 'Add Hot Bag', 'hotbag-save-btn')}
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
    // Two reads on purpose: the table below shows recent history (capped), while
    // the per-bag Open Issues column must count every open row, including ones
    // older than the cap.
    const [bags, maintenance, openBagIssues] = await Promise.all([
      fetchAllHotBags(),
      fetchHotBagMaintenanceHistory(),
      fetchOpenHotBagIssues(),
    ]);

    const openIssuesByBag = new Map();
    openBagIssues.forEach((m) => openIssuesByBag.set(m.bag_id, (openIssuesByBag.get(m.bag_id) || 0) + 1));

    const bagRows = bags
      .map((bag) => {
        const needsCleaning = isNeedsCleaning(bag);
        const openCount = openIssuesByBag.get(bag.id) || 0;
        const tone = !bag.active ? 'muted' : needsCleaning ? 'warn' : 'good';
        const label = !bag.active ? 'Inactive' : needsCleaning ? 'Needs Cleaning' : 'Current';
        return `
          <tr class="${bag.active ? '' : 'is-inactive'}">
            <td><strong>${escapeHtml(bag.name)}</strong></td>
            <td>${formatDate(bag.last_cleaned, 'Never')}</td>
            <td>${escapeHtml(String(bag.clean_window_days ?? HOT_BAG_CLEAN_WINDOW_DAYS))} days</td>
            <td>${badge(label, tone)}</td>
            <td>${openCount}</td>
            <td>${rowActions([
              { label: 'Edit', className: 'edit-bag-btn', data: { 'data-bag-id': bag.id } },
              {
                label: bag.active ? 'Deactivate' : 'Reactivate',
                className: 'toggle-bag-btn',
                data: { 'data-bag-id': bag.id },
              },
            ])}</td>
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
            <td>${badge(m.status, m.status === 'open' ? 'warn' : 'good')}</td>
            <td>${formatDateTime(m.submitted_at)}</td>
            <td>${rowActions([
              {
                label: m.status === 'open' ? 'Resolve' : 'Reopen',
                className: 'toggle-maintenance-btn',
                data: { 'data-maintenance-id': m.id },
              },
            ])}</td>
          </tr>
        `,
      )
      .join('');

    container.innerHTML = `
      ${sectionToolbar('Hot Bags', actionButton('+ Add Hot Bag', 'add-hotbag-btn'))}
      ${dataTable({
        columns: ['Bag', 'Last Cleaned', 'Clean Window', 'Status', 'Open Issues', 'Actions'],
        rows: bagRows,
        empty: 'No hot bags configured.',
      })}
      <h2 class="section-title">Maintenance History</h2>
      ${dataTable({
        columns: ['Bag', 'Issue', 'Notes', 'Status', 'Submitted', 'Actions'],
        rows: maintenanceRows,
        empty: 'No maintenance reports yet.',
      })}
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

    container.querySelectorAll('.toggle-maintenance-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const report = maintenance.find((m) => m.id === btn.dataset.maintenanceId);
        btn.disabled = true;
        try {
          await setHotBagIssueStatus(report.id, report.status === 'open');
          await renderHotBagsAdmin();
        } catch (err) {
          showError(err.message || 'Could not update this maintenance report. Try again.');
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
      ${field(
        'Name',
        'task-name-input',
        textInput({ id: 'task-name-input', placeholder: 'Task name', value: task?.name ?? '' }),
      )}
      ${field(
        'Description',
        'task-description-input',
        textArea({ id: 'task-description-input', placeholder: 'Optional', value: task?.description ?? '' }),
      )}
      ${field(
        'Recurs every (days)',
        'task-frequency-input',
        numberInput({ id: 'task-frequency-input', min: 1, value: task?.frequency_days ?? '' }),
      )}
      ${modalActions(isEdit ? 'Save Changes' : 'Add Task', 'task-save-btn')}
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
        const tone = !t.active ? 'muted' : due ? 'warn' : 'good';
        const label = !t.active ? 'Inactive' : due ? 'Due' : 'On Track';
        return `
          <tr class="clickable ${t.active ? '' : 'is-inactive'}" data-task-id="${escapeHtml(t.id)}">
            <td><strong>${escapeHtml(t.name)}</strong></td>
            <td>${frequencyLabel(t.frequency_days)}</td>
            <td>${formatDate(t.last_completed, 'Never')}</td>
            <td>${formatDate(t.next_due)}</td>
            <td>${badge(label, tone)}</td>
            <td>${rowActions([
              { label: 'Edit', className: 'edit-task-btn', data: { 'data-task-id': t.id } },
              {
                label: t.active ? 'Deactivate' : 'Reactivate',
                className: 'toggle-task-btn',
                data: { 'data-task-id': t.id },
              },
            ])}</td>
          </tr>
        `;
      })
      .join('');

    container.innerHTML = `
      ${sectionToolbar('Slow Tasks', actionButton('+ Add Slow Task', 'add-task-btn'))}
      ${dataTable({
        columns: ['Task', 'Frequency', 'Last Completed', 'Next Due', 'Status', 'Actions'],
        rows,
        empty: 'No slow tasks configured.',
      })}
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
      ${backLink('‹ Back to slow tasks', 'slowtask-detail-back')}
      <h2 class="section-title">${escapeHtml(task.name)} — Completion History</h2>
      ${
        completions.length >= HISTORY_PAGE_SIZE
          ? sectionHint(`Showing the ${HISTORY_PAGE_SIZE} most recent completions.`)
          : ''
      }
      ${dataTable({
        columns: ['Completed', 'By', 'Notes'],
        rows,
        empty: 'No completions recorded yet.',
      })}
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
