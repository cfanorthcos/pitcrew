# PitCrew

**Driver & Vehicle Operations** — a fast, iPad-first kiosk app for a
multi-location Chick-fil-A delivery operation. The kiosk is a command-center
board of every vehicle and its live status. A driver taps an available
vehicle, identifies themselves (pick from the driver list, or type a name if
they're not listed), and their shift starts. To sign out, they tap their own
in-use vehicle and complete the return checklist. Anyone can report a problem
with a car straight from the board, and the report shows on the vehicle's tile
until an admin resolves it. The board also has tabs for hot bag cleaning and
"slow tasks" — jobs on an interval, at set times of day, a set number of times a
day, or one-off, ordered by priority when several come due at once. An admin view (PIN-gated, asked every time it's opened)
gives leadership a live operations dashboard, full history, in-app
management of drivers, hot bags, and slow tasks, and a log of customer
complaints against specific drivers.

No mileage is tracked anywhere in this app — not on checkout, not on
return, not in the database.

## Tech stack

Plain HTML, CSS, and JavaScript (ES modules). No framework, no bundler, no
build step, no Node server. Data lives in Supabase (Postgres + REST via
`@supabase/supabase-js`, loaded from the [esm.sh](https://esm.sh) CDN).
This means the entire app is just static files — open `index.html` in a
browser or serve the folder with any static file host, including GitHub
Pages directly.

```
index.html            driver kiosk (single page, JS-driven view switching)
admin.html            admin dashboard (single page, grouped sidebar sections)
manifest.webmanifest  PWA manifest, so the kiosk installs full-screen on iPad
icon.svg              app icon referenced by the manifest
css/kiosk.css         driver kiosk styles (iOS Light, wall-mounted density)
css/admin.css         admin dashboard styles (same family, desktop density)
package.json          marks the project as ESM and holds the test script only
js/config.js          Supabase project URL + publishable key, tunables
js/data.js            all data-access functions, as a factory over a client
js/supabase.js        creates the live client and binds data.js to it
js/ui.js              shared UI helpers (escaping, formatting, modals, banners)
js/render.js          shared markup builders (tables, badges, form fields)
js/kiosk-render.js    kiosk-only components (pills, icon tiles, grouped rows)
js/icons.js           inline SVG icon set
js/match.js           driver name matching for the kiosk identity screen
js/version-watch.js   reloads the kiosk when a new version is deployed
js/app.js             driver kiosk logic
js/admin.js           admin dashboard logic
tests/                node --test suite, no dependencies
sql/schema.sql        full schema, RLS policies, and seed data
```

`js/ui.js` exists because `escapeHtml`, the date formatters and the banner
helpers were previously duplicated verbatim in `app.js` and `admin.js` — which
is how one escaping bug managed to live in two files at once. Anything both
screens need goes there.

### Adding the kiosk to the iPad home screen

Open the deployed URL in Safari → Share → **Add to Home Screen**. The manifest
plus the `apple-mobile-web-app-*` tags make it launch full-screen with no
Safari chrome, which is what you want for a wall-mounted kiosk.

## Supabase setup

Project: `https://rtxswisramlgnwbfggzu.supabase.co`. The **publishable**
key is already in `js/config.js` — that's expected, it's the frontend-safe
key and only grants what Row Level Security allows. The **service-role**
key must never be added to this repo or app.

### Run the SQL schema

1. Open the Supabase dashboard → SQL Editor for this project.
2. Paste the full contents of `sql/schema.sql` and run it once. This
   creates every table, the RLS policies, and seed data (3 drivers, 4
   vehicles, 5 return-checklist items, 4 hot bags, 2 slow tasks).
3. Re-running the file will fail on the second run (tables/seed rows
   already exist) — it's a one-time setup script, not a repeatable
   migration. If you need to reset, drop the tables first.

### Upgrading an already-provisioned project

If you ran `schema.sql` before the admin CRUD screens existed, run this
once to catch your project up (safe to re-run, uses `if not exists` /
`drop ... if exists`):

```sql
alter table public.hot_bags add column if not exists clean_window_days integer not null default 7;

drop policy if exists drivers_insert on public.drivers;
create policy drivers_insert on public.drivers for insert with check (true);

drop policy if exists drivers_update on public.drivers;
create policy drivers_update on public.drivers for update using (true) with check (true);

drop policy if exists hot_bags_insert on public.hot_bags;
create policy hot_bags_insert on public.hot_bags for insert with check (true);

drop policy if exists slow_tasks_insert on public.slow_tasks;
create policy slow_tasks_insert on public.slow_tasks for insert with check (true);

create table if not exists public.driver_incidents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers (id) on delete restrict,
  customer_name text,
  description text not null,
  status text not null default 'open',
  resolution_notes text,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists driver_incidents_driver_id_idx on public.driver_incidents (driver_id);
alter table public.driver_incidents enable row level security;

drop policy if exists driver_incidents_select on public.driver_incidents;
create policy driver_incidents_select on public.driver_incidents for select using (true);

drop policy if exists driver_incidents_insert on public.driver_incidents;
create policy driver_incidents_insert on public.driver_incidents for insert with check (true);

drop policy if exists driver_incidents_update on public.driver_incidents;
create policy driver_incidents_update on public.driver_incidents for update using (true) with check (true);
```

### Second upgrade: constraints, indexes, and duplicate-name protection

**Requires the previous section first** — this block touches
`driver_incidents`, which the first upgrade creates. Running it against a
project that hasn't had the first upgrade applied fails with
`relation "public.driver_incidents" does not exist`.

Run this once on an existing project to pick up the hardening added during the
code review. **Run the first query on its own** — the unique index will fail if
your `drivers` table already contains case-insensitive duplicates, and you need
to merge those by hand first (repoint `driving_sessions.driver_id` and
`driver_incidents.driver_id` at the row you're keeping, then deactivate the
other).

```sql
-- 1. Find duplicates BEFORE creating the index below. Expect zero rows.
select lower(name) as name, count(*), array_agg(id) as ids
from public.drivers group by lower(name) having count(*) > 1;

-- 2. One driver row per person, case-insensitively.
create unique index if not exists drivers_name_unique on public.drivers (lower(name));

-- 3. Constrain the free-text status columns to the two values the app reads.
alter table public.hot_bag_maintenance drop constraint if exists hot_bag_maintenance_status_check;
alter table public.hot_bag_maintenance
  add constraint hot_bag_maintenance_status_check check (status in ('open', 'resolved'));
alter table public.driver_incidents drop constraint if exists driver_incidents_status_check;
alter table public.driver_incidents
  add constraint driver_incidents_status_check check (status in ('open', 'resolved'));

-- 4. Indexes matching how the history screens actually sort (newest first).
create index if not exists driving_sessions_start_time_idx
  on public.driving_sessions (start_time desc);
create index if not exists hot_bag_maintenance_submitted_at_idx
  on public.hot_bag_maintenance (submitted_at desc);
create index if not exists driver_incidents_reported_at_idx
  on public.driver_incidents (reported_at desc);
```

If step 3 errors, some row already holds a status outside `open`/`resolved` —
find it with `select distinct status from public.driver_incidents;` and correct
it before retrying.

### Third upgrade: editable return checklist

Lets admin edit the return checklist from the app instead of SQL. Safe to
re-run.

```sql
drop policy if exists checklist_items_insert on public.checklist_items;
create policy checklist_items_insert on public.checklist_items for insert with check (true);

drop policy if exists checklist_items_update on public.checklist_items;
create policy checklist_items_update on public.checklist_items for update using (true) with check (true);
```

Until this runs, the Return Checklist screen still lists the items (reads were
always allowed) but every Add / Edit / Retire / reorder fails with "That change
didn't save — check that the database schema is up to date."

### Fourth upgrade: resolving hot bag issues

Lets admin resolve a reported hot bag issue instead of it staying open
forever. Safe to re-run.

```sql
drop policy if exists hot_bag_maintenance_update on public.hot_bag_maintenance;
create policy hot_bag_maintenance_update on public.hot_bag_maintenance
  for update using (true) with check (true);
```

Independent of the other three upgrades — it only touches
`hot_bag_maintenance`, which `schema.sql` has always created. Until this runs,
Resolve / Reopen fails with "That change didn't save — check that the database
schema is up to date."

### Fifth upgrade: managing vehicles from the app

Gives `vehicles` a client write path for the first time. Safe to re-run, and
independent of the other four.

```sql
drop policy if exists vehicles_insert on public.vehicles;
create policy vehicles_insert on public.vehicles for insert with check (true);

drop policy if exists vehicles_update on public.vehicles;
create policy vehicles_update on public.vehicles for update using (true) with check (true);
```

Until this runs, the Vehicles screen still lists the fleet and its history
(reads were always allowed) but **+ Add Vehicle**, **Edit**, **Take off road**
and **Retire** all fail with "That change didn't save — check that the database
schema is up to date."

Note what this widens: vehicles were the last table the publishable key could
not write to. See "Security considerations" below — this is a deliberate
trade of one more unauthenticated write path for not needing a developer to
take a car off the road.

### Sixth upgrade: vehicle issue reports, repeatable and prioritised slow tasks

Adds the `vehicle_maintenance` log the kiosk's "Report an issue with a vehicle"
button writes to, and gives `slow_tasks` a repeat flag, a priority, and the
ability to hold a one-off with no cadence. Safe to re-run, and independent of
the other five.

```sql
-- 1. Vehicle issue reports: the same shape as hot_bag_maintenance.
create table if not exists public.vehicle_maintenance (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles (id) on delete restrict,
  issue text not null,
  notes text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  submitted_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists vehicle_maintenance_vehicle_id_idx
  on public.vehicle_maintenance (vehicle_id);
create index if not exists vehicle_maintenance_submitted_at_idx
  on public.vehicle_maintenance (submitted_at desc);

alter table public.vehicle_maintenance enable row level security;

drop policy if exists vehicle_maintenance_select on public.vehicle_maintenance;
create policy vehicle_maintenance_select on public.vehicle_maintenance for select using (true);

drop policy if exists vehicle_maintenance_insert on public.vehicle_maintenance;
create policy vehicle_maintenance_insert on public.vehicle_maintenance for insert with check (true);

drop policy if exists vehicle_maintenance_update on public.vehicle_maintenance;
create policy vehicle_maintenance_update on public.vehicle_maintenance
  for update using (true) with check (true);

-- 2. Slow tasks: repeat flag + priority. Every existing task repeats, which is
--    what the default gives them, so nothing changes for rows already there.
alter table public.slow_tasks add column if not exists repeats boolean not null default true;
alter table public.slow_tasks
  add column if not exists priority text not null default 'normal';
alter table public.slow_tasks drop constraint if exists slow_tasks_priority_check;
alter table public.slow_tasks
  add constraint slow_tasks_priority_check check (priority in ('low', 'normal', 'high'));

-- 3. A one-off has no cadence, so frequency_days stops being mandatory — but a
--    repeating task without one would leave next_due frozen and the task
--    permanently due, so guard that instead.
alter table public.slow_tasks alter column frequency_days drop not null;
alter table public.slow_tasks drop constraint if exists slow_tasks_repeats_needs_frequency;
alter table public.slow_tasks
  add constraint slow_tasks_repeats_needs_frequency
  check (not repeats or (frequency_days is not null and frequency_days >= 1));

-- 4. Completing a one-off must not reschedule it. `create or replace` swaps the
--    function under the existing trigger — no need to touch the trigger itself.
create or replace function public.slow_tasks_set_next_due()
returns trigger
language plpgsql
as $$
begin
  if new.repeats and new.last_completed is not null then
    new.next_due := new.last_completed + make_interval(days => new.frequency_days);
  end if;
  return new;
end;
$$;
```

Until step 1 runs, the kiosk board and the admin Vehicles screen both still
work — the issue reads are best-effort — but the report button fails on submit
and no open-issue counts appear anywhere. Until steps 2–4 run, adding or editing
a slow task fails with "That change didn't save — check that the database schema
is up to date," and every existing task keeps behaving as a repeating one.

### Seventh upgrade: sub-daily slow tasks, and more than one name per completion

Replaces the `repeats` flag with a four-way `schedule`, moves cadences from days
to minutes so a task can recur several times a day, and moves "who completed it"
off the completion row into its own table so more than one person can be
credited. **Requires the sixth upgrade first** — it rewrites the columns that one
added. Safe to re-run.

```sql
-- 1. Cadences in minutes. A task that recurs every two hours cannot be
--    expressed in days, and having two cadence columns would mean every reader
--    checking both forever.
alter table public.slow_tasks add column if not exists frequency_minutes integer;
update public.slow_tasks
  set frequency_minutes = frequency_days * 1440
  where frequency_minutes is null and frequency_days is not null;

-- 2. The four schedules, replacing the repeats boolean. Everything that repeats
--    today is an interval task; everything else was already a one-off.
alter table public.slow_tasks add column if not exists schedule text;
update public.slow_tasks
  set schedule = case when coalesce(repeats, true) then 'interval' else 'once' end
  where schedule is null;
alter table public.slow_tasks alter column schedule set default 'interval';
alter table public.slow_tasks alter column schedule set not null;

alter table public.slow_tasks add column if not exists due_times time[];
alter table public.slow_tasks add column if not exists times_per_day integer;

-- 3. The old constraint and column come out together: the check references
--    repeats, so it has to go first either way.
alter table public.slow_tasks drop constraint if exists slow_tasks_repeats_needs_frequency;
alter table public.slow_tasks drop column if exists repeats;

-- 4. The trigger, taught the four schedules. This has to happen BEFORE any
--    further writes: PL/pgSQL binds column names at first execution, so the old
--    body would look for the repeats column that step 3 just dropped.
create or replace function public.slow_tasks_set_next_due()
returns trigger
language plpgsql
as $$
begin
  if new.schedule = 'interval' then
    if new.last_completed is null then
      new.next_due := coalesce(new.next_due, now());
    else
      new.next_due := new.last_completed + make_interval(mins => new.frequency_minutes);
    end if;
  elsif new.schedule <> 'once' then
    new.next_due := null;
  end if;
  return new;
end;
$$;

-- 5. next_due only means something for the two schedules that have a stored
--    instant. A clock-based task is resolved against the kiosk's local time,
--    because "8am" means 8am in the building.
alter table public.slow_tasks alter column next_due drop not null;
alter table public.slow_tasks alter column next_due drop default;
update public.slow_tasks set next_due = null where schedule in ('times_of_day', 'times_per_day');

alter table public.slow_tasks drop constraint if exists slow_tasks_schedule_check;
alter table public.slow_tasks add constraint slow_tasks_schedule_check
  check (schedule in ('once', 'interval', 'times_of_day', 'times_per_day'));

alter table public.slow_tasks drop constraint if exists slow_tasks_schedule_fields;
alter table public.slow_tasks add constraint slow_tasks_schedule_fields check (
  case schedule
    when 'once' then next_due is not null
    when 'interval' then frequency_minutes is not null
    when 'times_of_day' then due_times is not null and array_length(due_times, 1) >= 1
    when 'times_per_day' then times_per_day is not null
  end
);

alter table public.slow_tasks drop column if exists frequency_days;

-- 6. Who completed it, as its own table. Two people deep-clean the bags
--    together and both belong on the record; one FK column forces somebody off.
create table if not exists public.slow_task_completion_drivers (
  id uuid primary key default gen_random_uuid(),
  completion_id uuid not null references public.slow_task_completions (id) on delete cascade,
  driver_id uuid not null references public.drivers (id) on delete restrict,
  unique (completion_id, driver_id)
);
create index if not exists slow_task_completion_drivers_completion_id_idx
  on public.slow_task_completion_drivers (completion_id);
create index if not exists slow_task_completions_completed_at_idx
  on public.slow_task_completions (completed_at desc);

alter table public.slow_task_completion_drivers enable row level security;

drop policy if exists slow_task_completion_drivers_select on public.slow_task_completion_drivers;
create policy slow_task_completion_drivers_select
  on public.slow_task_completion_drivers for select using (true);

drop policy if exists slow_task_completion_drivers_insert on public.slow_task_completion_drivers;
create policy slow_task_completion_drivers_insert
  on public.slow_task_completion_drivers for insert with check (true);

-- 7. Move the existing names across, then drop the column. Every completion
--    that named somebody keeps naming them.
insert into public.slow_task_completion_drivers (completion_id, driver_id)
select id, completed_by from public.slow_task_completions where completed_by is not null
on conflict do nothing;

alter table public.slow_task_completions drop column if exists completed_by;
```

Run it as one block — the steps depend on each other, and the order matters:
step 3 drops the constraint that would otherwise reject step 2's rows, and step 4
must replace the trigger before anything writes again. If step 5's
`slow_tasks_schedule_fields` fails, some row has a schedule without the column
that describes it; `select id, name, schedule, frequency_minutes, due_times,
times_per_day, next_due from public.slow_tasks;` shows which.

Until this runs, the kiosk and admin both keep working on the old columns — the
app reads `repeats`/`frequency_days` as a fallback — but saving a task fails, and
the three new schedules are not selectable.

## Running locally

No build step — just serve the folder statically:

```bash
npx serve .
# or: python -m http.server 8080
```

Then open `http://localhost:<port>/index.html` for the driver kiosk, or
`/admin.html` for the admin dashboard.

## Running the tests

```bash
npm test        # or: node --test
```

No dependencies and no install step — this uses Node's built-in test runner
(Node 18+). `package.json` exists only to mark the project as ESM and to hold
that one script; nothing is bundled and nothing is downloaded.

The suite covers `js/ui.js` and the write paths in `js/data.js`. Every case
corresponds to a bug found in the August 2026 review, so they're regression
tests rather than coverage for its own sake — the escaping tests in particular
pin down a stored-XSS hole that shipped once already.

`js/data.js` takes the Supabase client as a parameter rather than importing a
singleton, which is what makes it testable: `js/supabase.js` imports the real
client from a CDN URL that Node can't resolve, and asserting against a live
database would be the wrong test anyway. `tests/fake-supabase.js` is a
call-recording stand-in, so tests can assert on statement *ordering* and
filters — which is where two of the bugs actually lived.

## Overdue shifts

A shift still open after `SHIFT_OVERDUE_HOURS` (12 by default, in
`js/config.js`) is flagged as **Overdue** on the kiosk tile and in the admin
dashboard's "On Shift Right Now" table.

It is only ever a flag. Nothing closes a session automatically, because an
automatic close would have to invent a return time, and a shift that really ran
three hours would then be indistinguishable from one that ran fourteen. The
driver can still return normally at any point.

To clear one, an admin uses **Force Close** on the dashboard row. That records
`end_time` as the moment the admin acted, leaves `checklist_completed` false,
and writes an explanatory note to `return_notes` — so a cleanup stays
distinguishable from a real return forever, in both the UI and raw SQL.

## Deploying to GitHub Pages

1. Push this repo to `github.com/cfanorthcos/pitcrew`.
2. In repo Settings → Pages, set Source to **Deploy from a branch**,
   branch `main`, folder `/ (root)`. No Actions workflow needed since
   there's no build step.
3. The site will be live at `https://cfanorthcos.github.io/pitcrew/`.

## How to change drivers

Admin → **Drivers** has full CRUD: "+ Add Driver" (name + optional employee
number), **Edit** on any row, and **Deactivate/Reactivate** to soft-remove
without losing history. Drivers can also self-add from the kiosk: at
checkout, if a driver isn't in the dropdown they can type their name, which
creates a driver row the same way (see "Security considerations" below).

Equivalent SQL, if you'd rather do it that way:

```sql
insert into drivers (name, employee_number) values ('New Driver', '1004');
update drivers set active = false where name = 'Old Driver'; -- soft-remove
```

Inactive drivers stop appearing on the kiosk's assign-vehicle dropdown but
their history is preserved.

## How to log a driver incident

Admin → **Driver Incidents** tracks customer complaints against a specific
driver — separate from the return checklist's damage/issue notes, which are
about the vehicle, not the driver. "+ Add Incident" (driver, optional
customer name, what happened), **Edit**, and **Resolve/Reopen** (adds a
`resolved_at` timestamp; resolution notes are editable any time). The
Drivers table also shows an **Open Incidents** count per driver so a
pattern is visible without opening this tab.

This is admin-only — the kiosk has no incident screen — but see "Security
considerations" below for why that's a UI-level distinction only, not an
enforced one.

## How to change the return checklist

Admin → **Return Checklist** controls the questions a driver must tick before
they can sign out. "+ Add Item", **Edit** to reword one, **↑ / ↓** to reorder,
and **Retire / Restore** to take one out of rotation.

Retiring never deletes: `driving_session_checklist_items` rows point at
`checklist_items.id`, so past returns must keep resolving to a real label.
Reordering renumbers `sort_order` as 1..n across the active items rather than
swapping a pair, so the order can't drift when two rows share a number.

If every item is retired, the kiosk says so and lets the driver sign out
directly — otherwise the return screen would have nothing to confirm and the
vehicle could never be handed back.

Equivalent SQL:

```sql
insert into checklist_items (label, sort_order) values ('Check tire pressure', 6);
update checklist_items set label = 'Remove all trash' where sort_order = 1;
update checklist_items set active = false where label = 'Old item'; -- retire
```

## How to change vehicles

Admin → **Vehicles** has full CRUD: "+ Add Vehicle" (name, colour name, the
colour the kiosk board paints, and status), **Edit**, and **Retire / Restore**.

**Take off road** is a separate one-tap button on each row, and it exists
because that edit is the time-critical one: a car comes off the road mid-shift
on a Saturday, not at a desk with time to open a dialog. It flips between
`available` and `out_of_service`. `needs_attention` is the nuanced case and
lives in **Edit**.

Retiring is not deleting: `driving_sessions` rows reference `vehicles.id`, so
history has to keep resolving to a real vehicle. A retired vehicle disappears
from the kiosk board and stays in admin so it can be brought back.

`status` is one of `available`, `needs_attention`, `out_of_service` — it's
the vehicle's condition, separate from whether it's currently checked out
(that's derived automatically from `driving_sessions`). An out-of-service
vehicle can still have an open session; the driver returns it normally.

### Vehicle issues reported from the kiosk

The kiosk's **Report an issue with a vehicle** button (under the vehicle board)
writes a row to `vehicle_maintenance`: which car, what kind of problem, and
optional notes. It's a button on the board rather than one on each tile because
the whole tile is a single tap target, and because an out-of-service tile isn't
tappable at all — which is exactly the car somebody most often needs to report.
Every active vehicle is offered, including ones currently checked out.

An open report shows as a red flag on that vehicle's kiosk tile, as an **Open
Issues** count on the admin Vehicles table, and as a dashboard tile. Admin →
**Vehicles** → *Reported Issues* has **Resolve / Reopen** on each row, the same
shape as hot bag maintenance and driver incidents: it sets `status`, stamps or
clears `resolved_at`, and never deletes the report.

Reporting deliberately does **not** change `vehicles.status`. A driver reporting
"needs cleaning" shouldn't take a car off the road, and an admin taking a car off
the road shouldn't silently close the report that prompted it — **Take off road**
stays the separate, deliberate action it was.

Equivalent SQL, if you'd rather:

```sql
insert into vehicles (name, color_name, color_hex)
  values ('Green Car', 'Green', '#2f8f4e');
update vehicles set status = 'out_of_service' where name = 'Blue Car';
update vehicles set active = false where name = 'Old Van'; -- soft-remove
```

## How to change hot bags

Admin → **Hot Bags** has full CRUD: "+ Add Hot Bag" (name + cleaning
window in days), **Edit**, and **Deactivate/Reactivate**. The Maintenance
History table below it has **Resolve / Reopen** on each reported issue, which
sets `status` and stamps or clears `resolved_at` — the same shape as driver
incidents. Resolving is what clears an issue out of the dashboard's open-issue
count; it never deletes the report, so the maintenance log stays complete. The cleaning
window is per-bag — each bag has its own "needs cleaning after N days"
(`clean_window_days`), so a high-volume bag can be set stricter than a
spare. `HOT_BAG_CLEAN_WINDOW_DAYS` in `js/config.js` is only the prefill
default when adding a new bag, not a global rule anymore.

Equivalent SQL:

```sql
insert into hot_bags (name, clean_window_days) values ('Hot Bag 05', 7);
update hot_bags set active = false where name = 'Hot Bag 01'; -- retire
```

## How to add or edit slow tasks

Admin → **Slow Tasks** has full CRUD: "+ Add Slow Task" (name, optional
description, schedule, priority), **Edit**, and **Deactivate/Reactivate**.

### The four schedules

**Repeats on a set interval** — a cadence plus a unit (minutes / hours / days /
weeks), stored as `frequency_minutes`. Rolls forward from each completion:
completing an every-3-hours task at 9:00 makes it due again at 12:00. `next_due`
is calculated by a database trigger whenever the row is saved with a
`last_completed`, so no one ever types a due date, and editing the cadence
recomputes it immediately from the existing `last_completed`.

**At set times of day** — a list of clock times in `due_times`, e.g. 8:00, 13:00,
18:00. Each time is its own run. A slot that passes without being done stays
visibly missed rather than sliding into the next one, and before the first slot
of the day the outstanding run is yesterday's last — otherwise an evening-only
task reads "not due" all night, which is exactly when somebody is at the board
wondering whether it got done.

**A set number of times a day** — `times_per_day`. Stays on the kiosk until it
has been completed that many times today, so one person can check it off and get
logged for it while leaving it available for the next person. The card shows
"1 of 3 done today". The tally resets at local midnight and comes from counting
`slow_task_completions`, not from a flag.

**One-time** — a due date instead of a cadence. Completing it finishes it for
good: it disappears from the kiosk on its own and reads **Completed** in admin.
Nobody has to remember to deactivate it. It keeps its completion history like any
other task.

Clock times and the daily tally are resolved against the **kiosk's own local
time**, not the server's. "The 8am walk" means 8am in the building, and a single
UTC instant cannot express that — which is why `next_due` is null for those two
schedules and the boards compute due-ness themselves.

### Priority

`low` / `normal` / `high`. It orders the kiosk's "Due now" list when several
tasks land at once (high first, then whichever has been due longest) and shows as
a pill on the card — it never changes *when* something becomes due. `normal`
shows no pill, because a badge on every card is a badge on none of them.
"Coming up" still reads by date, since that list is a calendar.

### Who completed it

The kiosk's Complete sheet is a checkbox list, not a dropdown: more than one
person can have worked on a task, and a `<select>` makes that a lie. Everyone
ticked is written to `slow_task_completion_drivers`, and the completion history
in admin shows all of them. Naming nobody is still allowed — it always was.

The list is ordered by who drove most recently, so the people actually in the
building are at the top rather than whoever is first alphabetically.

Equivalent SQL:

```sql
-- every two hours
insert into slow_tasks (name, schedule, frequency_minutes, priority)
  values ('Bathroom check', 'interval', 120, 'high');

-- at set times of day
insert into slow_tasks (name, schedule, due_times, priority)
  values ('Walk the lot', 'times_of_day', array['08:00','13:00','18:00']::time[], 'normal');

-- three times a day, any time
insert into slow_tasks (name, schedule, times_per_day)
  values ('Wipe down the staging counter', 'times_per_day', 3);

-- one-time: no cadence, a date instead
insert into slow_tasks (name, schedule, priority, next_due)
  values ('Swap the winter floor mats', 'once', 'low', now() + interval '14 days');
```

Every schedule must carry the column that describes it —
`slow_tasks_schedule_fields` enforces that, because an interval task with no
cadence has nothing to roll forward to and would sit permanently due while
looking like a bug in the kiosk.

## Security considerations

**This is V1: an unauthenticated kiosk.** The publishable key is used
directly from the browser with no login, for both `index.html` and
`admin.html`. Row Level Security is enabled on every table, but since
there's no per-user identity yet, the policies scope the `anon` role to
exactly the operations each screen needs (see the comments in
`sql/schema.sql`) rather than to "this belongs to this user." Concretely:

- No table allows `delete` from the client — history is permanent.
  "Deactivating" a driver/hot bag/slow task is always an `update` setting
  `active = false`, never a row delete.
- **Every table the app writes is now reachable by anyone with the
  publishable key**, whether or not they ever open `admin.html`: drivers,
  **vehicles**, hot bags, slow tasks, return-checklist items, sessions,
  hot bag **and vehicle** maintenance reports, completions, and driver
  incidents. Vehicles were the
  last read-only table and stopped being one when admin got vehicle CRUD —
  which means the kiosk board's contents are now writable with the same key
  the kiosk ships. Driver
  incidents are the most sensitive data in this schema (customer names,
  complaint details tied to a specific employee) and get exactly the same
  `using (true)` policy as everything else — worth prioritizing first if
  real auth ever gets added. The **PIN gate on `admin.html`**
  (`ADMIN_PIN` in `js/config.js`, checked entirely client-side) only hides
  the *buttons* for a casual kiosk wanderer — it is not a data boundary
  and doesn't stop someone from calling the Supabase REST API directly
  with the same key. Driver names are now unique case-insensitively at the
  database level (`drivers_name_unique`), but there's still no dedup on
  hot-bag or slow-task names and no rate limiting anywhere. Accepted for V1
  alongside the other unauthenticated-kiosk risks below — reconsider if it
  gets abused in practice, and see "Adding authentication later" for the
  real fix. The PIN is asked **every time** `admin.html` loads — it used to be
  remembered for the rest of the browser session, which on a wall-mounted iPad
  (whose session outlives everybody's shift) meant it was asked once and then
  effectively never again.
- **Anything a driver types is rendered in the admin's browser.** Because
  the kiosk can create driver rows and file hot-bag and vehicle issues with
  no login,
  free-text fields are an untrusted-input path from the public kiosk into
  the admin screens. All interpolation goes through `escapeHtml` in
  `js/ui.js`, which escapes quotes as well as angle brackets — the earlier
  implementation escaped only `&`, `<` and `>`, so a name like
  `" onfocus="…" autofocus x="` broke out of `value="…"` and ran in an
  admin's session. If you add a new template, interpolate through
  `escapeHtml`; never drop raw column values into markup.
- Anyone with the publishable key and the deployed URL could, in
  principle, call the same insert/update operations the kiosk and admin
  screens use (check out a vehicle, mark a bag cleaned, complete a task).
  That's an accepted risk for an internal, unauthenticated kiosk on
  physical hardware — it is **not** safe to treat this key as secret
  beyond that context.
- **Vehicle checkout concurrency** is enforced at the database level, not
  just in the UI: `driving_sessions_one_active_per_vehicle` is a partial
  unique index (`unique (vehicle_id) where end_time is null`), so two
  simultaneous checkout attempts on the same vehicle can't both succeed
  even under a race — the second insert fails and the app shows a clear
  "just checked out by someone else" message.

### Adding authentication later (no rewrite required)

`js/supabase.js` is the single choke point for every database call, and
`config.js`/`supabase.js` are already separated from the UI code in
`app.js`/`admin.js`. To add real auth:

1. Enable Supabase Auth (email/password or magic link) and add a sign-in
   screen — likely gating `admin.html` first, since that's the higher-risk
   surface.
2. Add a `role` (or similar) concept and tighten the RLS policies above to
   check `auth.uid()` / a role claim instead of `using (true)`, the same
   pattern already used for the read-only reference tables.
3. Nothing in `app.js` or `admin.js` needs to change beyond adding a login
   gate — they already only talk to Supabase through the functions in
   `supabase.js`.
