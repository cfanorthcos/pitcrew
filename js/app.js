import {
  fetchActiveDrivers,
  fetchRecentDriverIds,
  fetchVehiclesWithAvailability,
  createDriver,
  checkoutVehicle,
  fetchChecklistItems,
  returnVehicle,
  fetchHotBags,
  fetchOpenHotBagIssues,
  markHotBagCleaned,
  reportHotBagIssue,
  fetchSlowTasks,
  completeSlowTask,
} from './supabase.js';
import { HOT_BAG_CLEAN_WINDOW_DAYS } from './config.js';
import {
  escapeHtml,
  safeHex,
  inkOn,
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
import { field, textArea, select, modalActions } from './render.js';
import {
  pill,
  iconTile,
  avatar,
  listRow,
  chevron,
  checkRow,
  groupHead,
  groupFoot,
  emptyState,
  button,
} from './kiosk-render.js';
import { icon } from './icons.js';
import { searchDrivers, orderByRecent, findExactDriver, findConfusableDriver } from './match.js';
import { createVersionWatcher } from './version-watch.js';

const BOARD_REFRESH_MS = 20000;

// A wall-mounted screen at a work station has two jobs: it is an ambient fleet
// display, and it is a task device. Without this the second job destroys the
// first — somebody checks a hot bag, walks away, and the wall shows a bag list
// until the next person thinks to tap back. Everything returns to the board.
const IDLE_RETURN_MS = 45000;

// Poll for a deploy. Five minutes is far more often than this app ships, and a
// HEAD request every five minutes is nothing next to the board's own 20s refresh.
const VERSION_CHECK_MS = 300000;

const RECENT_LIMIT = 8;
const ISSUE_OPTIONS = ['Broken zipper', 'Damaged insulation', 'Dirty', 'Torn', 'Other'];

const state = {
  view: 'vehicles',
  vehicles: [],
  drivers: [],
  recentIds: [],
  vehicle: null, // the vehicle being checked out or returned
  identityMode: 'list', // 'list' | 'confirm'
  typedName: '',
  confusable: null,
  checklistItems: [],
  checked: new Set(),
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
const VIEWS = {
  vehicles: { title: 'Vehicles', tab: 'vehicles', chrome: 'brand', load: loadVehicles },
  hotbags: { title: 'Hot Bags', tab: 'hotbags', chrome: 'brand', load: loadHotBags },
  slowtasks: { title: 'Slow Tasks', tab: 'slowtasks', chrome: 'brand', load: loadSlowTasks },
  identity: { title: "Who's driving?", chrome: 'flow', load: loadIdentity },
  return: { title: 'Before you sign out', chrome: 'flow', load: loadReturn },
};

function setChrome(view) {
  const isFlow = view.chrome === 'flow';
  $('nav-brand').classList.toggle('hidden', isFlow);
  $('nav-clock').classList.toggle('hidden', isFlow);
  $('nav-back').classList.toggle('hidden', !isFlow);
  $('nav-context').classList.toggle('hidden', !isFlow);
  $('tab-bar').classList.toggle('hidden', isFlow);
  if (!isFlow) $('nav-cancel').classList.add('hidden');

  if (isFlow && state.vehicle) {
    $('nav-swatch').style.background = safeHex(state.vehicle.color_hex);
    $('nav-context-name').textContent = state.vehicle.name;
  }
}

async function switchView(key) {
  const view = VIEWS[key];
  state.view = key;

  document.querySelectorAll('.k-panel').forEach((el) => el.classList.remove('active'));
  $(`panel-${key}`).classList.add('active');

  $('k-title').textContent = view.title;
  $('k-trailing').innerHTML = '';
  setChrome(view);

  document.querySelectorAll('#tab-bar .k-tab').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === view.tab));
  });

  $('k-main').scrollTop = 0;
  await view.load();
}

// The flow screens are modal in spirit: leaving either one abandons a checkout
// or a return, so both exits clear the transient state rather than leaving a
// half-chosen vehicle behind for whoever walks up next.
function leaveFlow() {
  state.vehicle = null;
  state.identityMode = 'list';
  state.typedName = '';
  state.confusable = null;
  state.checked = new Set();
  $('driver-search').value = '';
  $('driver-search-clear').classList.add('hidden');
  switchView('vehicles');
}

$('tab-bar').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-tab]');
  if (btn) switchView(btn.dataset.tab);
});
$('nav-back').addEventListener('click', leaveFlow);
$('nav-cancel').addEventListener('click', leaveFlow);

// ---------------------------------------------------------------------------
// tab badges
// ---------------------------------------------------------------------------
function setTabCount(tab, count) {
  const chip = document.querySelector(`.k-tab-badge[data-count="${tab}"]`);
  if (!chip) return;
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
// vehicles
// ---------------------------------------------------------------------------
function vehicleState(vehicle) {
  if (vehicle.activeSession) {
    return isShiftOverdue(vehicle.activeSession.start_time) ? 'overdue' : 'inuse';
  }
  if (vehicle.status === 'out_of_service') return 'out';
  return 'free';
}

function vehicleTile(vehicle) {
  const kind = vehicleState(vehicle);
  const session = vehicle.activeSession;
  const paint = kind === 'out' ? '#c7c7cc' : safeHex(vehicle.color_hex);
  const glyph = iconTile(icon.car(32, inkOn(paint)), { background: paint });

  const status = {
    free: pill('Available', 'good'),
    inuse: pill('In use', 'info'),
    overdue: pill('Overdue', 'warn', icon.warning(15)),
    out: pill('Out of service', 'muted'),
  }[kind];

  const person = session
    ? `<div class="card-person">${escapeHtml(session.drivers?.name ?? 'Unknown driver')}</div>
       <div class="card-timer${kind === 'overdue' ? ' is-overdue' : ''}">
         <b data-since="${escapeHtml(session.start_time)}">—</b>${
           kind === 'overdue' ? ', no sign-out' : ' on shift'
         }
       </div>`
    : '';

  const action = {
    free: `<span class="btn btn-go">Take this one</span>`,
    inuse: `<span class="btn btn-tint">Return</span>`,
    overdue: `<span class="btn btn-tint">Return</span>`,
    out: `<div class="card-meta">Not available to take.</div>`,
  }[kind];

  const body = `
    ${glyph}
    <div class="card-title${kind === 'out' ? ' is-dim' : ''}">${escapeHtml(vehicle.name)}</div>
    ${status}
    <div class="card-spacer"></div>
    ${person}
    ${action}
  `;

  // The whole tile is the target, not a button inside it — a wall kiosk gets
  // tapped with the side of a thumb. Out-of-service tiles are a plain div so
  // they are not focusable and cannot be activated at all.
  if (kind === 'out') return `<div class="card is-muted">${body}</div>`;
  return `<button type="button" class="card" data-vehicle-id="${escapeHtml(vehicle.id)}">${body}</button>`;
}

async function loadVehicles({ spinner = true } = {}) {
  const board = $('vehicle-board');
  if (spinner && board.children.length === 0) board.innerHTML = emptyState('Loading…');
  try {
    const vehicles = await fetchVehiclesWithAvailability();
    state.vehicles = vehicles;

    const out = vehicles.filter((v) => v.activeSession).length;
    const free = vehicles.filter((v) => !v.activeSession && v.status !== 'out_of_service').length;
    if (state.view === 'vehicles') {
      $('k-trailing').innerHTML = `
        <span class="k-stat"><span class="k-dot" style="background:var(--tint)"></span><b>${out}</b> out</span>
        <span class="k-stat"><span class="k-dot" style="background:var(--green)"></span><b>${free}</b> free</span>
      `;
    }

    board.innerHTML = vehicles.length
      ? vehicles.map(vehicleTile).join('')
      : emptyState('No vehicles configured.');
    refreshTickers();
  } catch {
    showError('Could not load vehicles. Check your connection.');
    if (board.children.length === 0) board.innerHTML = emptyState('Could not load vehicles.');
  }
}

$('vehicle-board').addEventListener('click', (event) => {
  const tile = event.target.closest('[data-vehicle-id]');
  if (!tile) return;
  const vehicle = state.vehicles.find((v) => v.id === tile.dataset.vehicleId);
  if (!vehicle) return;
  state.vehicle = vehicle;
  switchView(vehicle.activeSession ? 'return' : 'identity');
});

// ---------------------------------------------------------------------------
// who's driving
// ---------------------------------------------------------------------------
async function loadIdentity() {
  const results = $('identity-results');
  $('nav-cancel').classList.remove('hidden');
  state.identityMode = 'list';
  results.innerHTML = emptyState('Loading…');

  try {
    const [drivers, recentIds] = await Promise.all([
      fetchActiveDrivers(),
      fetchRecentDriverIds().catch(() => []),
    ]);
    state.drivers = drivers;
    state.recentIds = recentIds;
    renderIdentity();
    $('driver-search').focus();
  } catch {
    showError('Could not load drivers. Check your connection.');
    results.innerHTML = emptyState('Could not load drivers.');
  }
}

function driverRow(driver) {
  return listRow({
    leadingHtml: avatar(driver.name),
    title: driver.name,
    trailingHtml: chevron(),
    data: { 'data-driver-id': driver.id },
  });
}

function renderIdentity() {
  const results = $('identity-results');
  if (state.identityMode === 'confirm') return renderConfusableConfirm();

  const query = state.typedName.trim();

  if (!query) {
    const ordered = orderByRecent(state.drivers, state.recentIds).slice(0, RECENT_LIMIT);
    results.innerHTML = `
      ${groupHead(state.recentIds.length ? 'Recent drivers' : 'Drivers')}
      <div class="group is-inset">
        ${ordered.map(driverRow).join('')}
        ${listRow({
          leadingHtml: `<span class="avatar is-tint">${icon.plus(26)}</span>`,
          title: "I'm not on this list",
          trailingHtml: chevron(),
          data: { 'data-add-new': 'true' },
        })}
      </div>
      ${groupFoot(
        state.recentIds.length
          ? 'Sorted by who drove most recently. Start typing to search everyone.'
          : 'Start typing to search.',
      )}
    `;
    return;
  }

  const matches = searchDrivers(state.drivers, query);
  results.innerHTML = `
    ${groupHead(matches.length ? 'Matches' : 'No match')}
    <div class="group is-inset">
      ${matches.map(driverRow).join('')}
      ${listRow({
        leadingHtml: `<span class="avatar is-tint">${icon.plus(26)}</span>`,
        title: `Add ${query} as a new driver`,
        sub: 'Creates a new driver and starts your shift.',
        trailingHtml: chevron(),
        data: { 'data-add-new': 'true' },
      })}
    </div>
  `;
}

// The churn insurance. drivers_name_unique already stops "mike smith" joining
// "Mike Smith"; nothing in the database stops "Mike Smith" becoming a second
// record beside "Michael Smith", and that is the one that actually happens.
function renderConfusableConfirm() {
  const match = state.confusable;
  $('identity-results').innerHTML = `
    ${groupHead('Did you mean')}
    <div class="group">
      ${listRow({
        leadingHtml: avatar(match.name, 'go'),
        title: match.name,
        sub: match.employee_number ? `Employee ${match.employee_number}` : 'Already on the roster',
        trailingHtml: `<span class="btn btn-go btn-auto">${icon.check(24, '#fff')}That's me</span>`,
        strong: true,
        data: { 'data-existing-id': match.id },
      })}
    </div>
    ${groupFoot(
      'Someone already on the roster has a very similar name. Starting a second record splits your shift history and your incident count across both.',
    )}
    <div class="stack-gap">
      ${groupHead('Or')}
      <div class="group">
        ${listRow({
          leadingHtml: `<span class="avatar is-tint">${icon.plus(26)}</span>`,
          title: `No — I'm new. Add me as ${state.typedName.trim()}.`,
          sub: 'Creates a new driver and starts your shift.',
          trailingHtml: chevron(),
          data: { 'data-create-anyway': 'true' },
        })}
      </div>
    </div>
  `;
}

const searchInput = $('driver-search');
searchInput.addEventListener('input', () => {
  state.typedName = searchInput.value;
  state.identityMode = 'list';
  $('driver-search-clear').classList.toggle('hidden', searchInput.value.length === 0);
  renderIdentity();
});
$('driver-search-clear').addEventListener('click', () => {
  searchInput.value = '';
  state.typedName = '';
  state.identityMode = 'list';
  $('driver-search-clear').classList.add('hidden');
  renderIdentity();
  searchInput.focus();
});

$('identity-results').addEventListener('click', async (event) => {
  const row = event.target.closest('button');
  if (!row) return;

  if (row.dataset.driverId) {
    const driver = state.drivers.find((d) => d.id === row.dataset.driverId);
    if (driver) await startShift(driver, row);
    return;
  }
  if (row.dataset.existingId) {
    const driver = state.confusable;
    await startShift(driver, row);
    return;
  }
  if (row.dataset.createAnyway) {
    await createAndStart(state.typedName.trim(), row);
    return;
  }
  if (row.dataset.addNew) {
    const typed = state.typedName.trim();
    if (!typed) {
      searchInput.focus();
      return;
    }
    await addDriverFlow(typed, row);
  }
});

// Exact match wins outright — that is the same person, not a question. Only a
// near-miss becomes a confirmation screen.
async function addDriverFlow(typed, row) {
  const exact = findExactDriver(typed, state.drivers);
  if (exact) {
    await startShift(exact, row);
    return;
  }
  const confusable = findConfusableDriver(typed, state.drivers);
  if (confusable) {
    state.confusable = confusable;
    state.identityMode = 'confirm';
    renderIdentity();
    return;
  }
  await createAndStart(typed, row);
}

function busy(row, label) {
  if (!row) return;
  row.disabled = true;
  const title = row.querySelector('.row-title');
  if (title) title.textContent = label;
}

async function createAndStart(name, row) {
  busy(row, 'Adding…');
  try {
    const driver = await createDriver(name);
    await startShift(driver, null);
  } catch (err) {
    showError(err.message || 'Could not add this driver. Try again.');
    renderIdentity();
  }
}

async function startShift(driver, row) {
  busy(row, 'Starting…');
  try {
    await checkoutVehicle(driver.id, state.vehicle.id);
    const name = driver.name;
    leaveFlow();
    showSuccess(`You're checked in, ${name}. Have a great shift!`);
  } catch (err) {
    showError(err.message || 'Could not check out this vehicle. Try again.');
    // A lost race means the board is stale — get it honest again and bail out
    // of the flow rather than leaving the driver on a dead checkout screen.
    leaveFlow();
  }
}

// ---------------------------------------------------------------------------
// return
// ---------------------------------------------------------------------------
async function loadReturn() {
  const container = $('return-checklist');
  const notes = $('return-notes');
  const submit = $('submit-return-btn');

  $('nav-cancel').classList.add('hidden');
  notes.value = '';
  state.checked = new Set();
  container.innerHTML = emptyState('Loading…');
  setReturnButton(0, 0);

  const session = state.vehicle?.activeSession;
  $('k-trailing').innerHTML = session
    ? `<span>${escapeHtml(session.drivers?.name ?? 'Unknown driver')} · <b class="tabular" data-since="${escapeHtml(
        session.start_time,
      )}">—</b></span>`
    : '';
  refreshTickers();

  try {
    const items = await fetchChecklistItems();
    state.checklistItems = items;

    // Admin can retire every item. With no branch here the list renders empty,
    // no change event ever fires, the button stays disabled forever and the
    // vehicle can never be handed back.
    if (items.length === 0) {
      container.innerHTML = emptyState('No checklist items — you can sign out directly.');
      setReturnButton(0, 0);
      return;
    }
    container.innerHTML = items.map((item) => checkRow({ id: item.id, label: item.label })).join('');
    setReturnButton(0, items.length);
  } catch {
    showError('Could not load the return checklist. Check your connection.');
    container.innerHTML = emptyState('Could not load the checklist.');
  }
}

// A disabled button that will not say why is the worst control on the screen.
// This one always states what is missing.
function setReturnButton(done, total) {
  const btn = $('submit-return-btn');
  const ready = done === total;
  const remaining = total - done;
  btn.disabled = !ready;
  btn.className = `btn ${ready ? 'btn-go' : 'btn-quiet'}`;
  btn.textContent = ready ? 'Complete & Sign Out' : `${remaining} item${remaining === 1 ? '' : 's'} left`;
}

$('return-checklist').addEventListener('click', (event) => {
  const row = event.target.closest('.check');
  if (!row) return;
  const id = row.dataset.itemId;
  const nowChecked = row.getAttribute('aria-checked') !== 'true';
  row.setAttribute('aria-checked', String(nowChecked));
  if (nowChecked) state.checked.add(id);
  else state.checked.delete(id);
  setReturnButton(state.checked.size, state.checklistItems.length);
});

$('submit-return-btn').addEventListener('click', async () => {
  const btn = $('submit-return-btn');
  const session = state.vehicle?.activeSession;
  if (!session) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await returnVehicle(session.id, [...state.checked], $('return-notes').value.trim());
    leaveFlow();
    showSuccess('Vehicle returned. Thanks for keeping PitCrew running smoothly.');
  } catch (err) {
    showError(err.message || 'Could not submit the return. Try again.');
    setReturnButton(state.checked.size, state.checklistItems.length);
  }
});

// ---------------------------------------------------------------------------
// hot bags
// ---------------------------------------------------------------------------
async function loadHotBags() {
  const container = $('hotbag-list');
  container.innerHTML = emptyState('Loading…');
  try {
    // Open maintenance reports used to be invisible here: a driver flagged a
    // torn bag and the card carried on reading normal until an admin happened
    // to open the dashboard. Best-effort so a missing policy cannot take the
    // whole tab down with it.
    const [bags, openIssues] = await Promise.all([
      fetchHotBags(),
      fetchOpenHotBagIssues().catch(() => []),
    ]);

    const issueByBag = new Map();
    openIssues.forEach((i) => issueByBag.set(i.bag_id, (issueByBag.get(i.bag_id) || 0) + 1));

    const needing = bags.filter(isNeedsCleaning).length;
    setTabCount('hotbags', needing);
    $('k-trailing').innerHTML = needing
      ? `<span><b class="tabular" style="color:var(--orange-ink)">${needing}</b> need cleaning</span>`
      : '<span>All current</span>';

    container.innerHTML = bags.length
      ? bags.map((bag) => hotBagCard(bag, issueByBag.get(bag.id) || 0)).join('')
      : emptyState('No hot bags configured.');
  } catch {
    showError('Could not load hot bags. Check your connection.');
    container.innerHTML = emptyState('Could not load hot bags.');
  }
}

function hotBagCard(bag, openIssues) {
  const needs = isNeedsCleaning(bag);
  const windowDays = bag.clean_window_days ?? HOT_BAG_CLEAN_WINDOW_DAYS;
  return `
    <div class="card">
      ${iconTile(icon.bag(32), {
        background: needs ? 'var(--orange-soft)' : 'var(--green-soft)',
        color: needs ? 'var(--orange-ink)' : 'var(--green-ink)',
      })}
      <div class="card-title">${escapeHtml(bag.name)}</div>
      ${needs ? pill('Needs cleaning', 'warn') : pill('Current', 'good')}
      <div class="card-meta">Cleaned ${escapeHtml(formatRelativeDays(bag.last_cleaned))} · every ${escapeHtml(
        String(windowDays),
      )} days</div>
      ${
        openIssues
          ? `<div class="flag">${icon.warning(20)}${escapeHtml(
              `${openIssues} open issue${openIssues === 1 ? '' : 's'}`,
            )}</div>`
          : ''
      }
      <div class="card-spacer"></div>
      ${button('Mark clean', {
        variant: needs ? 'go' : 'fill',
        data: { 'data-clean-bag': bag.id },
        iconHtml: needs ? icon.check(21, '#fff') : '',
      })}
      ${button('Report issue', { variant: 'plain', data: { 'data-issue-bag': bag.id } })}
    </div>
  `;
}

$('hotbag-list').addEventListener('click', async (event) => {
  const cleanBtn = event.target.closest('[data-clean-bag]');
  if (cleanBtn) {
    cleanBtn.disabled = true;
    cleanBtn.textContent = 'Saving…';
    try {
      await markHotBagCleaned(cleanBtn.dataset.cleanBag);
      showSuccess('Marked clean.');
      await loadHotBags();
    } catch (err) {
      showError(err.message || 'Could not update this hot bag. Try again.');
      await loadHotBags();
    }
    return;
  }
  const issueBtn = event.target.closest('[data-issue-bag]');
  if (issueBtn) openIssueModal(issueBtn.dataset.issueBag);
});

function openIssueModal(bagId) {
  let selected = null;
  const sheet = openModal('Report an issue', `
    <h2>Report Issue</h2>
    <div class="option-list">
      ${ISSUE_OPTIONS.map(
        (opt) => `<button type="button" class="option-btn" data-issue="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`,
      ).join('')}
    </div>
    ${field('Notes', 'issue-notes', textArea({ id: 'issue-notes', placeholder: 'Optional' }))}
    ${modalActions('Submit', 'issue-submit-btn', { disabled: true })}
  `);

  const submit = sheet.querySelector('#issue-submit-btn');
  sheet.querySelectorAll('.option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sheet.querySelectorAll('.option-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selected = btn.dataset.issue;
      submit.disabled = false;
    });
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      await reportHotBagIssue(bagId, selected, sheet.querySelector('#issue-notes').value.trim());
      closeModal();
      showSuccess('Issue reported. Thanks for flagging it.');
      await loadHotBags();
    } catch (err) {
      showError(err.message || 'Could not submit this issue. Try again.');
      submit.disabled = false;
      submit.textContent = 'Submit';
    }
  });
}

// ---------------------------------------------------------------------------
// slow tasks
// ---------------------------------------------------------------------------
async function loadSlowTasks() {
  const container = $('slowtask-list');
  container.innerHTML = emptyState('Loading…');
  try {
    const tasks = await fetchSlowTasks();
    const due = tasks.filter(isTaskDue);
    const upcoming = tasks.filter((t) => !isTaskDue(t));

    setTabCount('slowtasks', due.length);
    $('k-trailing').innerHTML = due.length
      ? `<span><b class="tabular" style="color:var(--orange-ink)">${due.length}</b> due now</span>`
      : '<span>Nothing due</span>';

    if (tasks.length === 0) {
      container.innerHTML = emptyState('No slow tasks configured.');
      return;
    }

    container.innerHTML = `
      ${
        due.length
          ? `${groupHead('Due now')}<div class="stack">${due.map(dueTaskCard).join('')}</div>`
          : `${groupHead('Due now')}${emptyState('Nothing due right now. Nice work.')}`
      }
      ${
        upcoming.length
          ? `<div class="stack-gap">${groupHead('Coming up')}
             <div class="group is-inset">${upcoming.map(upcomingRow).join('')}</div>
             ${groupFoot('Shown so a spare ten minutes can be spent ahead of the due date rather than waiting for it.')}
             </div>`
          : ''
      }
    `;
  } catch {
    showError('Could not load tasks. Check your connection.');
    container.innerHTML = emptyState('Could not load tasks.');
  }
}

function dueTaskCard(task) {
  return `
    <div class="feature">
      ${iconTile(icon.clock(36), { background: 'var(--orange-soft)', color: 'var(--orange-ink)' })}
      <div class="feature-body">
        <div class="feature-head">
          <span class="feature-title">${escapeHtml(task.name)}</span>
          ${pill('Due', 'warn')}
        </div>
        ${task.description ? `<span class="feature-desc">${escapeHtml(task.description)}</span>` : ''}
        <span class="feature-meta">${escapeHtml(frequencyLabel(task.frequency_days))} · last done ${escapeHtml(
          formatRelativeDays(task.last_completed),
        )}</span>
      </div>
      ${button('Complete', {
        variant: 'go',
        data: { 'data-complete-task': task.id },
        iconHtml: icon.check(25, '#fff'),
      })}
    </div>
  `;
}

function daysUntil(iso) {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function upcomingRow(task) {
  return listRow({
    leadingHtml: iconTile(icon.clock(26), { background: 'var(--fill)', color: 'var(--label-3)' }),
    title: task.name,
    sub: `${frequencyLabel(task.frequency_days)} · last done ${formatRelativeDays(task.last_completed)}`,
    trailingHtml: `<span class="pill pill-muted" style="margin-top:0">${escapeHtml(
      daysUntil(task.next_due) ?? '—',
    )}</span>`,
    data: { 'data-complete-task': task.id },
  });
}

$('slowtask-list').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-complete-task]');
  if (!btn) return;
  openTaskCompleteModal(btn.dataset.completeTask);
});

async function openTaskCompleteModal(taskId) {
  let drivers = [];
  try {
    drivers = await fetchActiveDrivers();
  } catch {
    showError('Could not load drivers. Check your connection.');
    return;
  }

  const sheet = openModal('Complete task', `
    <h2>Complete Task</h2>
    ${field(
      'Who completed it?',
      'task-driver-select',
      select({
        id: 'task-driver-select',
        placeholder: 'Not specified',
        options: drivers.map((d) => ({ value: d.id, label: d.name })),
      }),
    )}
    ${field('Notes', 'task-complete-notes', textArea({ id: 'task-complete-notes', placeholder: 'Optional' }))}
    ${modalActions('Mark Complete', 'task-complete-btn')}
  `);

  const btn = sheet.querySelector('#task-complete-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await completeSlowTask(
        taskId,
        sheet.querySelector('#task-driver-select').value || null,
        sheet.querySelector('#task-complete-notes').value.trim(),
      );
      closeModal();
      showSuccess('Marked complete.');
      await loadSlowTasks();
    } catch (err) {
      showError(err.message || 'Could not complete this task. Try again.');
      btn.disabled = false;
      btn.textContent = 'Mark Complete';
    }
  });
}

// ---------------------------------------------------------------------------
// ambient behaviour: auto-refresh and idle return
// ---------------------------------------------------------------------------
function startBoardAutoRefresh() {
  setInterval(() => {
    if (state.view !== 'vehicles' || isModalOpen()) return;
    loadVehicles({ spinner: false });
    refreshTabCounts();
  }, BOARD_REFRESH_MS);
}

let idleTimer = null;
let lastInteraction = Date.now();

function resetIdleTimer() {
  lastInteraction = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.view === 'vehicles' && !isModalOpen()) return;
    closeModal();
    leaveFlow();
  }, IDLE_RETURN_MS);
}

['pointerdown', 'keydown', 'input'].forEach((type) => {
  document.addEventListener(type, resetIdleTimer, { passive: true });
});

// Nobody reloads a wall-mounted screen, so it reloads itself when a deploy
// lands — but only sitting idle on the board, never mid-checkout or mid-return.
const versionWatcher = createVersionWatcher({
  url: 'index.html',
  fetchImpl: (...args) => fetch(...args),
  reload: () => window.location.reload(),
  isSafeToReload: () =>
    state.view === 'vehicles' &&
    !isModalOpen() &&
    Date.now() - lastInteraction > IDLE_RETURN_MS,
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
initOfflineBanner();
startTicker();
switchView('vehicles');
refreshTabCounts();
startBoardAutoRefresh();
resetIdleTimer();
versionWatcher.check();
setInterval(() => versionWatcher.check(), VERSION_CHECK_MS);
