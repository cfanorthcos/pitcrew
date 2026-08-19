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
-- slow_tasks: recurring, not-every-shift operational tasks
-- frequency_days: how often the task should recur, in days
-- ---------------------------------------------------------------------------
create table public.slow_tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  frequency_days integer not null,
  last_completed timestamptz,
  next_due timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.slow_task_completions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.slow_tasks (id) on delete cascade,
  completed_by uuid references public.drivers (id) on delete set null,
  completed_at timestamptz not null default now(),
  notes text
);

create index slow_task_completions_task_id_idx on public.slow_task_completions (task_id);

-- Whenever last_completed changes, recompute next_due automatically so
-- drivers/admins never type a due date.
create function public.slow_tasks_set_next_due()
returns trigger
language plpgsql
as $$
begin
  if new.last_completed is not null then
    new.next_due := new.last_completed + make_interval(days => new.frequency_days);
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
alter table public.driving_sessions enable row level security;
alter table public.checklist_items enable row level security;
alter table public.driving_session_checklist_items enable row level security;
alter table public.hot_bags enable row level security;
alter table public.hot_bag_maintenance enable row level security;
alter table public.driver_incidents enable row level security;
alter table public.slow_tasks enable row level security;
alter table public.slow_task_completions enable row level security;

-- Vehicles/checklist items are read-only reference data, managed by an
-- operator directly in the Supabase SQL editor (see README) — there is no
-- create/edit UI for them, so no client write policy is needed.
--
-- Drivers, hot bags, and slow tasks get full admin CRUD (select/insert/
-- update, never delete — deactivating sets active = false so history stays
-- intact). The kiosk's "Not listed — type my name" fallback also relies on
-- drivers_insert.
create policy drivers_select on public.drivers for select using (true);
create policy drivers_insert on public.drivers for insert with check (true);
create policy drivers_update on public.drivers for update using (true) with check (true);
create policy vehicles_select on public.vehicles for select using (true);
create policy checklist_items_select on public.checklist_items for select using (true);

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

create policy hot_bag_maintenance_select on public.hot_bag_maintenance for select using (true);
create policy hot_bag_maintenance_insert on public.hot_bag_maintenance for insert with check (true);

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

insert into public.slow_tasks (name, description, frequency_days, last_completed) values
  ('Deep clean delivery bags', 'Full wipe-down and sanitize of all hot bags, inside and out.', 30, now() - interval '25 days'),
  ('Inspect vehicle equipment', 'Check phone mounts, chargers, and delivery equipment in every vehicle.', 14, now() - interval '10 days');
