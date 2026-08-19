import {
  fetchActiveDrivers,
  fetchVehiclesWithAvailability,
  createDriver,
  findDriverByName,
  checkoutVehicle,
  fetchChecklistItems,
  returnVehicle,
  fetchHotBags,
  markHotBagCleaned,
  reportHotBagIssue,
  fetchSlowTasks,
  completeSlowTask,
} from './supabase.js';
import {
  escapeHtml,
  safeHex,
  formatDate,
  formatRelativeDays,
  frequencyLabel,
  isNeedsCleaning,
  isTaskDue,
  isShiftOverdue,
  showError,
  showSuccess,
  initOfflineBanner,
  openModal,
  closeModal,
  isModalOpen,
  startTicker,
  refreshTickers,
} from './ui.js';

const ISSUE_OPTIONS = ['Broken zipper', 'Damaged insulation', 'Dirty', 'Torn', 'Other'];
const BOARD_REFRESH_MS = 20000;

const state = {
  selectedVehicle: null,
  checklistItems: [],
  checkedItems: new Set(),
};

// ---------------------------------------------------------------------------
// tab navigation
//
// `checklist` is a sub-view of Vehicles rather than a tab of its own, so it
// declares which tab button stays lit while it's open. Without that, opening
// the return checklist used to un-highlight every tab at once.
// ---------------------------------------------------------------------------
const TABS = {
  vehicles: { render: loadVehicleBoard, highlight: 'vehicles' },
  hotbags: { render: loadHotBags, highlight: 'hotbags' },
  slowtasks: { render: loadSlowTasks, highlight: 'slowtasks' },
  checklist: { render: null, highlight: 'vehicles' },
};

async function switchTab(key) {
  const tab = TABS[key];
  document.querySelectorAll('.tab-panel').forEach((el) => el.classList.remove('active'));
  document.getElementById(`panel-${key}`).classList.add('active');
  document.querySelectorAll('#tab-bar button').forEach((btn) => {
    const isActive = btn.dataset.tab === tab.highlight;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  window.scrollTo(0, 0);
  if (tab.render) await tab.render();
}

document.getElementById('tab-bar').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

document.getElementById('checklist-back-btn').addEventListener('click', () => switchTab('vehicles'));

// ---------------------------------------------------------------------------
// status rail — live counts across the top of the board
// ---------------------------------------------------------------------------
function renderRail(vehicles) {
  const out = vehicles.filter((v) => v.activeSession).length;
  const free = vehicles.filter((v) => !v.activeSession && v.status !== 'out_of_service').length;
  document.getElementById('rail-out').textContent = String(out);
  document.getElementById('rail-free').textContent = String(free);
}

// Attention counts on the tab buttons, so a driver standing at the kiosk can
// see there's work waiting without opening each tab.
function setTabCount(tabKey, count) {
  const chip = document.querySelector(`#tab-bar button[data-tab="${tabKey}"] .tab-count`);
  chip.textContent = String(count);
  chip.classList.toggle('hidden', count === 0);
}

async function refreshTabCounts() {
  const [bags, tasks] = await Promise.all([
    fetchHotBags().catch(() => null),
    fetchSlowTasks().catch(() => null),
  ]);
  if (bags) setTabCount('hotbags', bags.filter(isNeedsCleaning).length);
  if (tasks) setTabCount('slowtasks', tasks.filter(isTaskDue).length);
}

// ---------------------------------------------------------------------------
// vehicle board (command center)
// ---------------------------------------------------------------------------
function tileStatus(vehicle) {
  if (vehicle.activeSession) {
    // Flagged, not acted on: the tile still returns normally, it just stops
    // looking like a healthy shift so someone asks about it.
    return isShiftOverdue(vehicle.activeSession.start_time)
      ? { key: 'overdue', label: 'Overdue', action: 'Tap to return' }
      : { key: 'in-use', label: 'In Use', action: 'Tap to return' };
  }
  if (vehicle.status === 'out_of_service') {
    return { key: 'out', label: 'Out of Service', action: 'Unavailable' };
  }
  if (vehicle.status === 'needs_attention') {
    return { key: 'attention', label: 'Needs Attention', action: 'Tap to take' };
  }
  return { key: 'available', label: 'Available', action: 'Tap to take' };
}

function buildVehicleTile(vehicle) {
  const status = tileStatus(vehicle);
  const session = vehicle.activeSession;

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = `tile is-${status.key}`;
  tile.disabled = status.key === 'out';
  tile.style.setProperty('--vehicle-color', safeHex(vehicle.color_hex));
  tile.innerHTML = `
    <span class="tile-band"></span>
    <span class="tile-head">
      <span class="tile-name">${escapeHtml(vehicle.name)}</span>
      <span class="tile-swatch" aria-hidden="true"></span>
    </span>
    <span class="tile-status">${status.label}</span>
    <span class="tile-info">
      ${
        session
          ? `<span class="tile-driver">${escapeHtml(session.drivers?.name ?? 'Unknown driver')}</span>
             <span class="tile-timer"><b data-since="${escapeHtml(session.start_time)}">—</b> ${
               status.key === 'overdue' ? 'without signing out' : 'on shift'
             }</span>`
          : `<span class="tile-driver tile-driver-idle">${escapeHtml(vehicle.color_name)}</span>`
      }
    </span>
    <span class="tile-action">${status.action}</span>
  `;

  tile.addEventListener('click', () => {
    if (status.key === 'out') return;
    if (session) openReturnChecklist(vehicle);
    else openAssignModal(vehicle);
  });
  return tile;
}

// `showSpinner` is off for the 20s poll: the board used to blank itself to
// "Loading…" on every refresh, so a wall-mounted kiosk flickered three times a
// minute and any tile you were reaching for vanished under your finger.
async function loadVehicleBoard({ showSpinner = true } = {}) {
  const board = document.getElementById('vehicle-board');
  if (showSpinner) board.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const vehicles = await fetchVehiclesWithAvailability();
    renderRail(vehicles);
    if (vehicles.length === 0) {
      board.innerHTML = '<p class="empty-state">No vehicles configured.</p>';
      return;
    }
    board.replaceChildren(...vehicles.map(buildVehicleTile));
    refreshTickers();
  } catch {
    showError('Could not load vehicles. Check your connection.');
    if (showSpinner) board.innerHTML = '<p class="empty-state">Could not load vehicles.</p>';
  }
}

function startBoardAutoRefresh() {
  setInterval(() => {
    const onBoard = document.getElementById('panel-vehicles').classList.contains('active');
    if (!onBoard || isModalOpen()) return;
    loadVehicleBoard({ showSpinner: false });
    refreshTabCounts();
  }, BOARD_REFRESH_MS);
}

// ---------------------------------------------------------------------------
// assign modal: pick a vehicle, then identify yourself to start a shift
// ---------------------------------------------------------------------------
async function openAssignModal(vehicle) {
  let drivers = [];
  try {
    drivers = await fetchActiveDrivers();
  } catch {
    showError('Could not load drivers. Check your connection.');
    return;
  }

  const sheet = openModal(
    `Check out ${vehicle.name}`,
    `
      <h2>Check Out ${escapeHtml(vehicle.name)}</h2>
      <p class="meta">Who's driving?</p>
      <div>
        <label class="field-label" for="assign-driver-select">Select your name</label>
        <select id="assign-driver-select">
          <option value="">Select…</option>
          ${drivers.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
          <option value="__other__">Not listed — type my name</option>
        </select>
      </div>
      <div id="assign-other-wrap" class="hidden">
        <label class="field-label" for="assign-other-name">Your name</label>
        <input type="text" id="assign-other-name" placeholder="Full name" autocomplete="name" />
      </div>
      <button type="button" class="btn btn-primary" id="assign-confirm-btn" disabled>Start Shift</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const select = sheet.querySelector('#assign-driver-select');
  const otherWrap = sheet.querySelector('#assign-other-wrap');
  const otherInput = sheet.querySelector('#assign-other-name');
  const confirmBtn = sheet.querySelector('#assign-confirm-btn');

  function refreshConfirmState() {
    confirmBtn.disabled =
      select.value === '__other__' ? otherInput.value.trim().length === 0 : select.value === '';
  }

  select.addEventListener('change', () => {
    otherWrap.classList.toggle('hidden', select.value !== '__other__');
    if (select.value === '__other__') otherInput.focus();
    refreshConfirmState();
  });
  otherInput.addEventListener('input', refreshConfirmState);

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Starting…';
    try {
      let driverId = select.value;
      let driverName;

      if (driverId === '__other__') {
        const typedName = otherInput.value.trim();
        // Checked against every driver, not just the active dropdown — an
        // inactive driver typing their own name should be reactivated history,
        // not a brand-new duplicate row.
        const existing = await findDriverByName(typedName);
        const driver = existing ?? (await createDriver(typedName));
        driverId = driver.id;
        driverName = driver.name;
      } else {
        driverName = drivers.find((d) => d.id === driverId)?.name ?? '';
      }

      await checkoutVehicle(driverId, vehicle.id);
      closeModal();
      showSuccess(`You're checked in, ${driverName}. Have a great shift!`);
      await loadVehicleBoard({ showSpinner: false });
    } catch (err) {
      showError(err.message || 'Could not check out this vehicle. Try again.');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Start Shift';
      // A lost checkout race means the board is stale; get it honest again.
      loadVehicleBoard({ showSpinner: false });
    }
  });
}

// ---------------------------------------------------------------------------
// end shift: tap an in-use vehicle tile, complete the checklist to sign out
// ---------------------------------------------------------------------------
async function openReturnChecklist(vehicle) {
  state.selectedVehicle = vehicle;
  await switchTab('checklist');

  document.getElementById('checklist-summary').innerHTML = `
    <div class="card-row">
      <div class="confirm-detail">Vehicle<strong>${escapeHtml(vehicle.name)}</strong></div>
      <div class="confirm-detail">Driver<strong>${escapeHtml(
        vehicle.activeSession.drivers?.name ?? 'Unknown',
      )}</strong></div>
    </div>
  `;

  await loadReturnChecklist();
}

async function loadReturnChecklist() {
  const container = document.getElementById('return-checklist');
  const notesEl = document.getElementById('return-notes');
  const submitBtn = document.getElementById('submit-return-btn');
  notesEl.value = '';
  state.checkedItems = new Set();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Complete & Sign Out';
  container.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const items = await fetchChecklistItems();
    state.checklistItems = items;
    container.replaceChildren(
      ...items.map((item) => {
        const row = document.createElement('label');
        row.className = 'checklist-item';
        row.innerHTML = `<input type="checkbox" /><span>${escapeHtml(item.label)}</span>`;
        const checkbox = row.querySelector('input');
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.checkedItems.add(item.id);
          else state.checkedItems.delete(item.id);
          row.classList.toggle('checked', checkbox.checked);
          submitBtn.disabled = state.checkedItems.size !== items.length;
        });
        return row;
      }),
    );
  } catch {
    showError('Could not load the return checklist. Check your connection.');
    container.innerHTML = '<p class="empty-state">Could not load the checklist.</p>';
  }
}

document.getElementById('submit-return-btn').addEventListener('click', async () => {
  const btn = document.getElementById('submit-return-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const notes = document.getElementById('return-notes').value.trim();
    await returnVehicle(state.selectedVehicle.activeSession.id, [...state.checkedItems], notes);
    showSuccess('Vehicle returned. Thanks for keeping PitCrew running smoothly.');
    await switchTab('vehicles');
  } catch (err) {
    showError(err.message || 'Could not submit the return. Try again.');
    btn.disabled = false;
    btn.textContent = 'Complete & Sign Out';
  }
});

// ---------------------------------------------------------------------------
// hot bag check
// ---------------------------------------------------------------------------
async function loadHotBags() {
  const container = document.getElementById('hotbag-list');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const bags = await fetchHotBags();
    setTabCount('hotbags', bags.filter(isNeedsCleaning).length);
    if (bags.length === 0) {
      container.innerHTML = '<p class="empty-state">No hot bags configured.</p>';
      return;
    }
    container.replaceChildren(...bags.map(buildHotBagCard));
  } catch {
    showError('Could not load hot bags. Check your connection.');
    container.innerHTML = '<p class="empty-state">Could not load hot bags.</p>';
  }
}

function buildHotBagCard(bag) {
  const needsCleaning = isNeedsCleaning(bag);
  const card = document.createElement('div');
  card.className = `card item-card ${needsCleaning ? 'is-flagged' : ''}`;
  card.innerHTML = `
    <div class="title-row">
      <h3>${escapeHtml(bag.name)}</h3>
      <span class="badge ${needsCleaning ? 'badge-warn' : 'badge-good'}">${
        needsCleaning ? 'Needs Cleaning' : 'Current'
      }</span>
    </div>
    <div class="meta">Cleaned ${formatRelativeDays(bag.last_cleaned)} · ${formatDate(
      bag.last_cleaned,
      'no record',
    )}</div>
    <div class="actions">
      <button type="button" class="btn ${
        needsCleaning ? 'btn-primary' : 'btn-secondary'
      } mark-cleaned-btn">Mark Cleaned</button>
      <button type="button" class="btn btn-secondary report-issue-btn">Report Issue</button>
    </div>
  `;

  card.querySelector('.mark-cleaned-btn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await markHotBagCleaned(bag.id);
      showSuccess(`${bag.name} marked clean.`);
      await loadHotBags();
    } catch (err) {
      showError(err.message || 'Could not update this hot bag. Try again.');
      btn.disabled = false;
      btn.textContent = 'Mark Cleaned';
    }
  });
  card.querySelector('.report-issue-btn').addEventListener('click', () => openIssueModal(bag));
  return card;
}

function openIssueModal(bag) {
  let selectedIssue = null;

  const sheet = openModal(
    `Report an issue with ${bag.name}`,
    `
      <h2>Report Issue</h2>
      <p class="meta">${escapeHtml(bag.name)}</p>
      <div class="option-list">
        ${ISSUE_OPTIONS.map(
          (opt) =>
            `<button type="button" class="option-btn" data-issue="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`,
        ).join('')}
      </div>
      <div>
        <label class="field-label" for="issue-notes">Notes</label>
        <textarea id="issue-notes" placeholder="Optional"></textarea>
      </div>
      <button type="button" class="btn btn-primary" id="issue-submit-btn" disabled>Submit</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const submitBtn = sheet.querySelector('#issue-submit-btn');

  sheet.querySelectorAll('.option-btn').forEach((optBtn) => {
    optBtn.addEventListener('click', () => {
      sheet.querySelectorAll('.option-btn').forEach((b) => b.classList.remove('selected'));
      optBtn.classList.add('selected');
      selectedIssue = optBtn.dataset.issue;
      submitBtn.disabled = false;
    });
  });

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
      const notes = sheet.querySelector('#issue-notes').value.trim();
      await reportHotBagIssue(bag.id, selectedIssue, notes);
      closeModal();
      showSuccess('Issue reported. Thanks for flagging it.');
      await loadHotBags();
    } catch (err) {
      showError(err.message || 'Could not submit this issue. Try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  });
}

// ---------------------------------------------------------------------------
// slow tasks
// ---------------------------------------------------------------------------
async function loadSlowTasks() {
  const container = document.getElementById('slowtask-list');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const due = (await fetchSlowTasks()).filter(isTaskDue);
    setTabCount('slowtasks', due.length);
    if (due.length === 0) {
      container.innerHTML = '<p class="empty-state">No tasks due right now. Nice work.</p>';
      return;
    }
    container.replaceChildren(...due.map(buildSlowTaskCard));
  } catch {
    showError('Could not load tasks. Check your connection.');
    container.innerHTML = '<p class="empty-state">Could not load tasks.</p>';
  }
}

function buildSlowTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'card item-card is-flagged';
  card.innerHTML = `
    <div class="title-row">
      <h3>${escapeHtml(task.name)}</h3>
      <span class="badge badge-warn">Due</span>
    </div>
    ${task.description ? `<div class="meta">${escapeHtml(task.description)}</div>` : ''}
    <div class="meta">${frequencyLabel(task.frequency_days)} · last done ${formatRelativeDays(
      task.last_completed,
    )}</div>
    <div class="actions">
      <button type="button" class="btn btn-primary complete-task-btn">Complete</button>
    </div>
  `;
  card.querySelector('.complete-task-btn').addEventListener('click', () => openTaskCompleteModal(task));
  return card;
}

// Completing a task used to post `completed_by: null` unconditionally, so the
// slow_task_completions.completed_by column and the admin's "By" column were
// permanently empty. Ask who did it — optional, so it stays a one-tap flow.
async function openTaskCompleteModal(task) {
  let drivers = [];
  try {
    drivers = await fetchActiveDrivers();
  } catch {
    showError('Could not load drivers. Check your connection.');
    return;
  }

  const sheet = openModal(
    `Complete ${task.name}`,
    `
      <h2>Complete Task</h2>
      <p class="meta">${escapeHtml(task.name)}</p>
      <div>
        <label class="field-label" for="task-driver-select">Who completed it?</label>
        <select id="task-driver-select">
          <option value="">Not specified</option>
          ${drivers.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="field-label" for="task-complete-notes">Notes</label>
        <textarea id="task-complete-notes" placeholder="Optional"></textarea>
      </div>
      <button type="button" class="btn btn-primary" id="task-complete-btn">Mark Complete</button>
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    `,
  );

  const completeBtn = sheet.querySelector('#task-complete-btn');
  completeBtn.addEventListener('click', async () => {
    completeBtn.disabled = true;
    completeBtn.textContent = 'Saving…';
    try {
      const driverId = sheet.querySelector('#task-driver-select').value || null;
      const notes = sheet.querySelector('#task-complete-notes').value.trim();
      await completeSlowTask(task.id, driverId, notes);
      closeModal();
      showSuccess(`${task.name} marked complete.`);
      await loadSlowTasks();
    } catch (err) {
      showError(err.message || 'Could not complete this task. Try again.');
      completeBtn.disabled = false;
      completeBtn.textContent = 'Mark Complete';
    }
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
initOfflineBanner();
startTicker();
loadVehicleBoard();
refreshTabCounts();
startBoardAutoRefresh();
