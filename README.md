# PitCrew

**Driver & Vehicle Operations** — a fast, iPad-first kiosk app for a
multi-location Chick-fil-A delivery operation. The kiosk is a command-center
board of every vehicle and its live status. A driver taps an available
vehicle, identifies themselves (pick from the driver list, or type a name if
they're not listed), and their shift starts. To sign out, they tap their own
in-use vehicle and complete the return checklist. The board also has tabs
for hot bag cleaning and recurring "slow tasks." An admin view (PIN-gated)
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
admin.html            admin dashboard (single page, tab-driven sections)
manifest.webmanifest  PWA manifest, so the kiosk installs full-screen on iPad
icon.svg              app icon referenced by the manifest
css/styles.css        shared stylesheet
package.json          marks the project as ESM and holds the test script only
js/config.js          Supabase project URL + publishable key, tunables
js/data.js            all data-access functions, as a factory over a client
js/supabase.js        creates the live client and binds data.js to it
js/ui.js              shared UI helpers (escaping, formatting, modals, banners)
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

## How to change vehicles

```sql
insert into vehicles (name, color_name, color_hex)
  values ('Green Car', 'Green', '#2f8f4e');
update vehicles set status = 'out_of_service' where name = 'Blue Car';
update vehicles set active = false where name = 'Old Van'; -- soft-remove
```

`status` is one of `available`, `needs_attention`, `out_of_service` — it's
the vehicle's condition, separate from whether it's currently checked out
(that's derived automatically from `driving_sessions`).

## How to change hot bags

Admin → **Hot Bags** has full CRUD: "+ Add Hot Bag" (name + cleaning
window in days), **Edit**, and **Deactivate/Reactivate**. The cleaning
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
description, recurrence in days), **Edit**, and **Deactivate/Reactivate**.

Equivalent SQL:

```sql
insert into slow_tasks (name, description, frequency_days)
  values ('Check delivery supplies', 'Restock bags, receipt paper, etc.', 14);
```

`frequency_days` is how often the task recurs. `next_due` is calculated
automatically by a database trigger whenever the row is saved with a
`last_completed` value set — no one ever types a due date, and editing
`frequency_days` on an already-completed task recomputes `next_due`
immediately from the existing `last_completed`.

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
- Vehicles and checklist items are still **read-only** from the client;
  they're only ever changed via direct SQL. Everything else the app writes
  to — drivers, hot bags, slow tasks, sessions, maintenance reports,
  completions, **driver incidents** — is reachable by anyone with the
  publishable key, whether or not they ever open `admin.html`. Driver
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
  real fix.
- **Anything a driver types is rendered in the admin's browser.** Because
  the kiosk can create driver rows and file hot-bag issues with no login,
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
