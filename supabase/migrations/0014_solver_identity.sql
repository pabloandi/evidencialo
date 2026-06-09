-- 0014_solver_identity.sql
-- Subsystem B, chunk B1: solver identity & admin grant infra. No public
-- behavior change yet — this is the foundation B2/B3 build on.
--
-- Adds two role-check helpers in `private` (per the 0004 hardening pattern,
-- unreachable via PostgREST RPC), the `solver_profiles` table (1:1 with
-- profiles, public read / no client writes), and the admin-only `grant_solver`
-- RPC that atomically promotes a profile to `solver` AND inserts its public
-- solver profile. The `'solver'` enum value was added in 0013 (separate tx).

-- ---------------------------------------------------------------------------
-- Role-check helpers (private schema — not reachable via /rest/v1/rpc).
-- Mirror private.is_staff() from 0004 EXACTLY: SECURITY DEFINER so they read
-- profiles regardless of the caller's RLS context (and avoid policy recursion),
-- search_path='' so every reference is schema-qualified.
-- ---------------------------------------------------------------------------
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;
revoke execute on function private.is_admin() from public;
grant execute on function private.is_admin() to anon, authenticated;

create or replace function private.is_solver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'solver'
  );
$$;
revoke execute on function private.is_solver() from public;
grant execute on function private.is_solver() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- solver_profiles: the public identity of a verified solver (1:1 with profiles).
-- `links` is forward-compat for subsystem D (donation/social links).
-- citext is NOT enabled in this project (only postgis) — handle uniqueness is a
-- lower(handle) unique index, not a citext column.
-- ---------------------------------------------------------------------------
create table public.solver_profiles (
  id          uuid primary key references public.profiles (id) on delete cascade,
  handle      text not null,
  type        text not null check (type in ('government', 'influencer', 'org')),
  bio         text,
  avatar_url  text,
  links       jsonb not null default '{}'::jsonb,
  verified_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id),
  created_at  timestamptz not null default now()
);

-- Case-insensitive handle uniqueness (used by /solucionadores/[handle]).
create unique index solver_profiles_handle_lower_key
  on public.solver_profiles (lower(handle));

-- ---------------------------------------------------------------------------
-- RLS: the public profile is world-readable; all writes go through the DEFINER
-- RPC / service role (no permissive insert/update/delete policy for clients),
-- matching the 0003 convention.
-- ---------------------------------------------------------------------------
grant select on public.solver_profiles to anon, authenticated;

alter table public.solver_profiles enable row level security;

create policy solver_profiles_select_public on public.solver_profiles
  for select using (true);

-- ---------------------------------------------------------------------------
-- grant_solver: admin-only, atomic promote-to-solver + public profile insert.
-- SECURITY DEFINER so the single transaction (UPDATE profiles + INSERT
-- solver_profiles) is one privileged unit; the FIRST statement is the
-- private.is_admin() gate, so the function is its own security boundary.
-- Attribution (verified_by) comes from auth.uid() inside the body — never a
-- client arg.
-- ---------------------------------------------------------------------------
create or replace function public.grant_solver(
  p_user_id    uuid,
  p_handle     text,
  p_type       text,
  p_bio        text default null,
  p_avatar_url text default null,
  p_links      jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- DB-layer authz: only admins may mint solvers. The security boundary does
  -- not rest on the HTTP route.
  if not private.is_admin() then
    raise exception 'only admin' using errcode = '42501';
  end if;

  -- Promote the existing profile. Solvers always have a profiles row (created
  -- by the handle_new_user trigger), so a missing row is a clean error — NEVER
  -- create an orphan solver_profiles that FKs a non-existent profile.
  update public.profiles
  set role = 'solver'
  where id = p_user_id;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;

  -- Insert the public solver profile; verified_by = the admin (auth.uid()).
  insert into public.solver_profiles (id, handle, type, bio, avatar_url, links, verified_by)
  values (
    p_user_id,
    p_handle,
    p_type,
    p_bio,
    p_avatar_url,
    p_links,
    (select auth.uid())
  );
end;
$$;

-- Only authenticated callers may invoke it; anon never can. The internal
-- private.is_admin() gate further restricts the effect to admins.
-- NOTE: Supabase's default privileges explicitly grant EXECUTE on public
-- functions to anon/authenticated/service_role, so `revoke ... from public` is
-- NOT enough — anon must be revoked by name (otherwise linter 0028 fires and an
-- anon could reach the function, only to be stopped by the is_admin() gate).
revoke execute on function public.grant_solver(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.grant_solver(uuid, text, text, text, text, jsonb) to authenticated;
