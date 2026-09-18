-- PitCrew V1 schema
-- Chick-fil-A driver & vehicle operations kiosk.
-- Run this whole file once in the Supabase SQL editor for a fresh project.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- drivers
-- ---------------------------------------------------------------------------
create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  employee_number text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per person, case-insensitively. The kiosk's "not listed — type my
-- name" path dedupes before inserting, but that check is a read-then-write and
-- two drivers typing the same name at once would both pass it. This is the
-- guarantee; the app-side check just produces a friendlier outcome.
create unique index drivers_name_unique on public.drivers (lower(name));

-- ---------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------
create type vehicle_status as enum ('available', 'needs_attention', 'out_of_service');

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color_name text not null,
  color_hex text not null,
  status vehicle_status not null default 'available',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Issues drivers report against a vehicle from the kiosk. Deliberately separate
-- from vehicles.status: status is the operator's decision about whether the car
-- is drivable, this is the raw report that leads to that decision. Same shape as
-- hot_bag_maintenance so both logs resolve and read identically.
create table public.vehicle_maintenance (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles (id) on delete restrict,
  issue text not null,
  notes text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  submitted_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index vehicle_maintenance_vehicle_id_idx on public.vehicle_maintenance (vehicle_id);
create index vehicle_maintenance_submitted_at_idx on public.vehicle_maintenance (submitted_at desc);

-- ---------------------------------------------------------------------------
-- driving_sessions (no mileage tracking, ever)
-- ---------------------------------------------------------------------------
create table public.driving_sessions (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers (id) on delete restrict,
  vehicle_id uuid not null references public.vehicles (id) on delete restrict,
  start_time timestamptz not null default now(),
  end_time timestamptz,
  checklist_completed boolean not null default false,
  return_notes text,
  created_at timestamptz not null default now()
);

create index driving_sessions_driver_id_idx on public.driving_sessions (driver_id);
create index driving_sessions_vehicle_id_idx on public.driving_sessions (vehicle_id);
-- Driver History and the vehicle detail view both read newest-first.
create index driving_sessions_start_time_idx on public.driving_sessions (start_time desc);

-- A vehicle can have at most one open (end_time is null) session at a time.
-- This is the real concurrency guarantee: two simultaneous checkout attempts
-- race on this unique index and only one insert wins.
create unique index driving_sessions_one_active_per_vehicle
  on public.driving_sessions (vehicle_id)
  where end_time is null;

-- ---------------------------------------------------------------------------
-- vehicle_checklist_items: normalized checklist definition + per-session
-- completion, rather than hardcoded boolean columns.
-- ---------------------------------------------------------------------------
create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order integer not null default 0,
  active boolean not null default true
);

create table public.driving_session_checklist_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.driving_sessions (id) on delete cascade,
  item_id uuid not null references public.checklist_items (id) on delete restrict,
  checked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (session_id, item_id)
);

create index driving_session_checklist_items_session_id_idx
  on public.driving_session_checklist_items (session_id);

-- ---------------------------------------------------------------------------
-- hot_bags
-- ---------------------------------------------------------------------------
create table public.hot_bags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  last_cleaned timestamptz,
  -- how many days this specific bag can go without cleaning before the
  -- kiosk/admin flag it — bags see different volume, so this is per-bag
  -- rather than one global window (see js/config.js for the fallback).
  clean_window_days integer not null default 7,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.hot_bag_maintenance (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references public.hot_bags (id) on delete cascade,
  issue text not null,
  notes text,
  -- vehicles.status is an enum; these were free text, so a typo'd or
  -- API-inserted value would silently never match the 'open' filters the
  -- dashboards count on.
  status text not null default 'open' check (status in ('open', 'resolved')),
  submitted_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index hot_bag_maintenance_bag_id_idx on public.hot_bag_maintenance (bag_id);
create index hot_bag_maintenance_submitted_at_idx on public.hot_bag_maintenance (submitted_at desc);

-- ---------------------------------------------------------------------------
-- driver_incidents: customer complaints about a specific driver, logged and
-- tracked by admin (not by the kiosk).
-- ---------------------------------------------------------------------------
create table public.driver_incidents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers (id) on delete restrict,
  customer_name text,
  description text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution_notes text,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index driver_incidents_driver_id_idx on public.driver_incidents (driver_id);
create index driver_incidents_reported_at_idx on public.driver_incidents (reported_at desc);

-- ---------------------------------------------------------------------------
-- slow_tasks: not-every-shift operational tasks
--
-- schedule decides how the task comes back, and which of the three shape
-- columns below applies. Four kinds, because a bathroom check every two hours,
-- a bag deep-clean every month, an open/mid/close walk at set times, and a
-- one-off floor-mat swap are genuinely four different things:
--
--   once           done once and finished. next_due is the date somebody chose;
--                  completing it never reschedules it, and it drops off the
--                  kiosk on its own without anybody deactivating it.
--   interval       rolls forward from each completion by frequency_minutes.
--                  Minutes, not days, so "every 2 hours" and "every 30 days"
--                  are the same column.
--   times_of_day   due at each clock time in due_times. A slot that passes
--                  uncompleted stays visibly missed rather than sliding.
--   times_per_day  must be done times_per_day times before the day is out, in
--                  any order, at any time. The tally resets at local midnight.
--                  This is the one that lets somebody check a task off, get
--                  logged for it, and leave it available for the next person.
--
-- priority         which task to spend the spare ten minutes on when several
--                  are due at once. Ordering inside a due list, never a date.
--
-- next_due is only meaningful for 'once' and 'interval' — see the trigger.
-- ---------------------------------------------------------------------------
create table public.slow_tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  schedule text not null default 'interval'
    check (schedule in ('once', 'interval', 'times_of_day', 'times_per_day')),
  frequency_minutes integer check (frequency_minutes is null or frequency_minutes >= 1),
  -- Local wall-clock times, not instants: "the 8am walk" is 8am in the store
  -- whatever the server thinks the date is. The app resolves them against the
  -- kiosk's own clock, which is the clock in the building.
  due_times time[],
  times_per_day integer check (times_per_day is null or times_per_day >= 1),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  last_completed timestamptz,
  next_due timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  -- Each schedule needs exactly the column that describes it. Without this a
  -- task can be saved as 'interval' with no cadence, which leaves next_due
  -- frozen and the task permanently due — the failure is silent and looks like
  -- a bug in the kiosk rather than a bad row.
  constraint slow_tasks_schedule_fields check (
    case schedule
      when 'once' then next_due is not null
      when 'interval' then frequency_minutes is not null
      when 'times_of_day' then due_times is not null and array_length(due_times, 1) >= 1
      when 'times_per_day' then times_per_day is not null
    end
  )
);

create table public.slow_task_completions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.slow_tasks (id) on delete cascade,
  completed_at timestamptz not null default now(),
  notes text
);

create index slow_task_completions_task_id_idx on public.slow_task_completions (task_id);
-- The kiosk counts today's completions on every board refresh to know whether a
-- times_per_day task still has runs left in it.
create index slow_task_completions_completed_at_idx
  on public.slow_task_completions (completed_at desc);

-- Who did it, as its own table rather than a completed_by column on the row
-- above. Two people deep-clean the bags together and both should be on the
-- record; a single FK forces somebody to be left off, and the normalised shape
-- is the same call the return checklist already made.
create table public.slow_task_completion_drivers (
  id uuid primary key default gen_random_uuid(),
  completion_id uuid not null references public.slow_task_completions (id) on delete cascade,
  driver_id uuid not null references public.drivers (id) on delete restrict,
  unique (completion_id, driver_id)
);

create index slow_task_completion_drivers_completion_id_idx
  on public.slow_task_completion_drivers (completion_id);

-- next_due is a stored instant, so it only makes sense for the two schedules
-- that have one. An interval task rolls forward from its last completion; a
-- one-off keeps the date somebody typed, because completing it finishes it
-- rather than rescheduling it. The two clock-based schedules are resolved
-- against the kiosk's local time and deliberately store nothing here — a
-- single UTC instant cannot express "8am in the store, every day".
create function public.slow_tasks_set_next_due()
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

create trigger slow_tasks_before_write
  before insert or update on public.slow_tasks
  for each row execute function public.slow_tasks_set_next_due();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- V1 is an unauthenticated kiosk (see README "Security considerations").
-- The anon/publishable key is used directly from the browser with no login,
-- so these policies scope the *anon* role to exactly the operations the
-- kiosk and admin screens need today, with no delete access anywhere
-- (history is permanent). There is no per-user identity yet to scope
-- further against — that's the gap Supabase Auth closes later without
-- requiring an app rewrite (see README).
-- ---------------------------------------------------------------------------
alter table public.drivers enable row level security;
alter table public.vehicles enable row level security;
alter table public.vehicle_maintenance enable row level security;
alter table public.driving_sessions enable row level security;
alter table public.checklist_items enable row level security;
alter table public.driving_session_checklist_items enable row level security;
alter table public.hot_bags enable row level security;
alter table public.hot_bag_maintenance enable row level security;
alter table public.driver_incidents enable row level security;
alter table public.slow_tasks enable row level security;
alter table public.slow_task_completions enable row level security;
alter table public.slow_task_completion_drivers enable row level security;

-- Vehicles now have admin CRUD like everything else. They were SQL-only for
-- longer than they should have been: taking a car off the road is the most
-- time-critical edit in the whole app and it was the one thing that needed a
-- developer. Never delete — deactivating sets active = false so the driving
-- history keeps resolving to a real vehicle.
--
-- Drivers, hot bags, and slow tasks get full admin CRUD (select/insert/
-- update, never delete — deactivating sets active = false so history stays
-- intact). The kiosk's "Not listed — type my name" fallback also relies on
-- drivers_insert.
create policy drivers_select on public.drivers for select using (true);
create policy drivers_insert on public.drivers for insert with check (true);
create policy drivers_update on public.drivers for update using (true) with check (true);
create policy vehicles_select on public.vehicles for select using (true);
create policy vehicles_insert on public.vehicles for insert with check (true);
create policy vehicles_update on public.vehicles for update using (true) with check (true);

-- vehicle_maintenance: the kiosk files issues from the board, admin resolves
-- them on the Vehicles screen. Update is what makes Resolve/Reopen work — the
-- same pair hot_bag_maintenance and driver_incidents already have. Never
-- delete: the maintenance log is history.
create policy vehicle_maintenance_select on public.vehicle_maintenance for select using (true);
create policy vehicle_maintenance_insert on public.vehicle_maintenance for insert with check (true);
create policy vehicle_maintenance_update on public.vehicle_maintenance
  for update using (true) with check (true);
create policy checklist_items_select on public.checklist_items for select using (true);
-- The return checklist is edited from admin (label, order, active). No delete:
-- historical driving_session_checklist_items rows must keep resolving to a real
-- label, so retiring an item sets active = false.
create policy checklist_items_insert on public.checklist_items for insert with check (true);
create policy checklist_items_update on public.checklist_items for update using (true) with check (true);

-- driving_sessions: kiosk can open a session (insert) and close its own open
-- session (update); everyone can read for dashboards/history.
create policy driving_sessions_select on public.driving_sessions for select using (true);
create policy driving_sessions_insert on public.driving_sessions for insert with check (true);
create policy driving_sessions_update on public.driving_sessions
  for update using (end_time is null) with check (true);

create policy driving_session_checklist_items_select
  on public.driving_session_checklist_items for select using (true);
create policy driving_session_checklist_items_insert
  on public.driving_session_checklist_items for insert with check (true);

-- hot_bags: kiosk reads all bags and updates last_cleaned; admin adds new
-- bags and edits name/clean_window_days/active.
create policy hot_bags_select on public.hot_bags for select using (true);
create policy hot_bags_insert on public.hot_bags for insert with check (true);
create policy hot_bags_update on public.hot_bags for update using (true) with check (true);

-- hot_bag_maintenance: the kiosk files issues, admin resolves them. Update is
-- needed for the Resolve/Reopen action -- without it the status column and the
-- dashboard's open-issue count are write-once and every issue stays open
-- forever. Never delete: the maintenance log is history.
create policy hot_bag_maintenance_select on public.hot_bag_maintenance for select using (true);
create policy hot_bag_maintenance_insert on public.hot_bag_maintenance for insert with check (true);
create policy hot_bag_maintenance_update on public.hot_bag_maintenance for update using (true) with check (true);

-- driver_incidents: admin-only in practice (no kiosk screen touches this
-- table), but there's no per-role identity to enforce that at the RLS
-- level yet, so it's select/insert/update like the other admin CRUD
-- tables — never delete, resolving just sets status/resolved_at.
create policy driver_incidents_select on public.driver_incidents for select using (true);
create policy driver_incidents_insert on public.driver_incidents for insert with check (true);
create policy driver_incidents_update on public.driver_incidents for update using (true) with check (true);

-- slow_tasks: kiosk reads due tasks and updates last_completed on
-- completion; admin adds new tasks and edits name/description/frequency.
create policy slow_tasks_select on public.slow_tasks for select using (true);
create policy slow_tasks_insert on public.slow_tasks for insert with check (true);
create policy slow_tasks_update on public.slow_tasks for update using (true) with check (true);

create policy slow_task_completions_select on public.slow_task_completions for select using (true);
create policy slow_task_completions_insert on public.slow_task_completions for insert with check (true);

-- Who completed a task. Insert-only from the kiosk like the completion itself;
-- never updated, never deleted — a completion record that can be rewritten is
-- not a record.
create policy slow_task_completion_drivers_select
  on public.slow_task_completion_drivers for select using (true);
create policy slow_task_completion_drivers_insert
  on public.slow_task_completion_drivers for insert with check (true);

-- ---------------------------------------------------------------------------
-- seed data — see README "How to change drivers/vehicles/hot bags" for how
-- to edit this safely after the first run.
-- ---------------------------------------------------------------------------
insert into public.drivers (name, employee_number) values
  ('Driver 1', '1001'),
  ('Driver 2', '1002'),
  ('Driver 3', '1003');

insert into public.vehicles (name, color_name, color_hex) values
  ('Red Car', 'Red', '#c8102e'),
  ('Blue Car', 'Blue', '#1f6fb2'),
  ('Black Car', 'Black', '#1c1c1c'),
  ('White Car', 'White', '#e8e6e1');

insert into public.checklist_items (label, sort_order) values
  ('Remove trash from vehicle', 1),
  ('Vehicle interior is reasonably clean', 2),
  ('Vehicle exterior is reasonably clean', 3),
  ('Return delivery equipment', 4),
  ('Report any damage or issue', 5);

insert into public.hot_bags (name, last_cleaned) values
  ('Hot Bag 01', now() - interval '2 days'),
  ('Hot Bag 02', now() - interval '10 days'),
  ('Hot Bag 03', now() - interval '1 days'),
  ('Hot Bag 04', now() - interval '9 days');

-- One of each schedule, so every shape in the table above has a worked example.
insert into public.slow_tasks (name, description, schedule, frequency_minutes, priority, last_completed) values
  ('Deep clean delivery bags', 'Full wipe-down and sanitize of all hot bags, inside and out.',
   'interval', 30 * 1440, 'high', now() - interval '25 days'),
  ('Inspect vehicle equipment', 'Check phone mounts, chargers, and delivery equipment in every vehicle.',
   'interval', 14 * 1440, 'normal', now() - interval '10 days');

insert into public.slow_tasks (name, description, schedule, due_times, priority) values
  ('Walk the lot', 'Trash, carts, and anything blocking the delivery bays.',
   'times_of_day', array['08:00', '13:00', '18:00']::time[], 'normal');

insert into public.slow_tasks (name, description, schedule, times_per_day, priority) values
  ('Wipe down the staging counter', 'Anyone can take a run at this; it needs doing three times a shift.',
   'times_per_day', 3, 'normal');

-- A one-off: no cadence, just a date it needs doing by.
insert into public.slow_tasks (name, description, schedule, priority, next_due) values
  ('Swap the winter floor mats', 'One-time changeover across the whole fleet.',
   'once', 'low', now() + interval '14 days');
