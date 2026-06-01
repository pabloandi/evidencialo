-- 0002_core_tables.sql
-- Core domain: profiles, categories, reports, report_media, status history.
-- A report is geolocated media (geography Point) + category + description.
-- Reports are born invisible (is_visible=false) and media born pending; the
-- visibility trigger (step 08) flips visibility once all media is processed.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.user_role as enum ('citizen', 'staff', 'admin');
create type public.report_status as enum ('nuevo', 'en_proceso', 'resuelto', 'descartado');
create type public.media_type as enum ('image', 'video');
create type public.media_processing_state as enum ('pending', 'processed', 'failed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         public.user_role not null default 'citizen',
  display_name text,
  created_at   timestamptz not null default now()
);

create table public.categories (
  id    uuid primary key default gen_random_uuid(),
  slug  text unique not null,
  name  text not null,
  icon  text
);

create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users (id) on delete set null, -- null = anonymous
  category_id uuid not null references public.categories (id),
  status      public.report_status not null default 'nuevo',
  description text,
  location    extensions.geography(Point, 4326) not null,
  address     text,
  is_visible  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.report_media (
  id               uuid primary key default gen_random_uuid(),
  report_id        uuid not null references public.reports (id) on delete cascade,
  storage_path     text not null,
  type             public.media_type not null,
  width            integer,
  height           integer,
  duration_s       integer,
  processing_state public.media_processing_state not null default 'pending',
  created_at       timestamptz not null default now()
);

create table public.report_status_history (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.reports (id) on delete cascade,
  from_status public.report_status,
  to_status   public.report_status not null,
  changed_by  uuid references public.profiles (id),
  note        text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index reports_location_gix on public.reports using gist (location);
create index reports_status_idx on public.reports (status);
create index reports_created_at_idx on public.reports (created_at desc);
create index report_media_report_id_idx on public.report_media (report_id);
create index report_status_history_report_id_idx on public.report_status_history (report_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Role check for RLS. SECURITY DEFINER so it reads profiles regardless of the
-- caller's RLS context (and avoids recursion). The JWT-claim optimization is
-- deferred to step 04 (auth); behavior is identical.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('staff', 'admin')
  );
$$;

-- Keep reports.updated_at fresh.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

-- Create a profile row (default role 'citizen') for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Seed categories (idempotent — applied to local and remote alike)
-- ---------------------------------------------------------------------------
insert into public.categories (slug, name, icon) values
  ('bache',        'Bache',                 'road'),
  ('basura',       'Basura no recogida',    'trash'),
  ('alumbrado',    'Alumbrado roto',        'bulb'),
  ('senalizacion', 'Señalización dañada',   'sign'),
  ('otros',        'Otros',                 'dots')
on conflict (slug) do nothing;
