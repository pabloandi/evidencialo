-- 0018_report_validations.sql
-- Subsystem A, chunk A1: citizen validation / corroboration (DB layer).
--
-- Other citizens/witnesses corroborate that an ORIGINAL report is real ("yo
-- también lo veo"). Corroboration is additive trust: it earns a public
-- "Corroborado" badge (derived in the app from verified_count) and feeds a
-- solver/staff priority score — it never hides a report and never gates
-- publication. Trust is anchored to AUTHENTICATED confirmations (the author
-- counts as the first); ANONYMOUS confirmations add reach at reduced weight but
-- cannot forge the badge.
--
-- What it adds, in order:
--   (a) public.report_validations — one row per confirmation. Identity is XOR:
--       exactly one of validator_id (authenticated = auth.uid()) / ip_hash
--       (anonymous, hashed client IP). Verified-vs-anonymous is DERIVED from
--       validator_id IS NOT NULL (no redundant is_verified column). Dedup via two
--       partial-unique indexes (one per user / one per IP per report).
--   (b) reports.verified_count / anon_count — denormalized aggregates — plus
--       priority_score GENERATED (verified_count + anon_count / 4): integer
--       division FLOORS the anon contribution (4 anon -> +1), so the anon weight
--       lives here; the badge threshold lives in app config.
--   (c) public.report_validations_recount — AFTER INSERT OR DELETE recompute
--       trigger (mirrors refresh_report_visibility): locks the report row, recounts
--       from scratch, UPDATEs only when the counts actually change.
--   (d) public.reports_seed_author_validation — AFTER INSERT on reports seeds a
--       verified row for the author (when reporter_id is set), which fires the
--       recount -> verified_count = 1. Anonymous reports start at 0.
--   (e) public.validate_report(uuid, text) — the ONLY client write path. DEFINER
--       so it bypasses RLS to insert; gates validatability; ON CONFLICT DO NOTHING
--       for idempotent re-confirm; returns the FRESH counts read from reports.
--   (f) RLS — grant SELECT to anon + authenticated; withhold INSERT/UPDATE/DELETE
--       from clients (only the DEFINER RPC/triggers write); SELECT policies
--       select-own + select-admin.
--   (g) reports_in_view v3 — DROP+CREATE (additive return columns force this;
--       create or replace cannot change a return type) + re-grant, adding
--       verified_count / anon_count for the map popup.
--
-- Convention notes (match every prior migration):
--   * The table is secured by RLS, NOT by revoking base DML grants.
--   * The RPC is SECURITY DEFINER with search_path='' and is REVOKEd from public
--     then granted BY FULL SIGNATURE. Anon EXECUTE on validate_report is
--     INTENTIONAL (anonymous corroboration); captcha + rate-limit live in the API
--     route, not the DB. The recount/seed triggers are revoked from everyone.

-- ---------------------------------------------------------------------------
-- (a) Table
-- ---------------------------------------------------------------------------
create table public.report_validations (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid not null references public.reports (id) on delete cascade,
  validator_id uuid references auth.users (id) on delete set null, -- authenticated = auth.uid(); null = anonymous
  ip_hash      text,                                               -- anonymous only (hashed client IP); null when authenticated
  created_at   timestamptz not null default now(),
  -- Exactly one identity present: a row is EITHER verified (validator_id) XOR
  -- anonymous (ip_hash), never both and never neither.
  constraint report_validations_identity_chk
    check ((validator_id is null) <> (ip_hash is null))
);

-- Dedup: one confirmation per authenticated user per report.
create unique index report_validations_one_per_user
  on public.report_validations (report_id, validator_id)
  where validator_id is not null;

-- Dedup: one confirmation per hashed IP per report.
create unique index report_validations_one_per_ip
  on public.report_validations (report_id, ip_hash)
  where ip_hash is not null;

create index report_validations_report_idx
  on public.report_validations (report_id);

-- ---------------------------------------------------------------------------
-- (b) reports aggregate columns. verified_count / anon_count are maintained by
-- the recount trigger below. priority_score is GENERATED: integer division
-- floors the anon contribution (4 anon -> +1, 3 anon -> +0) — intended, not a
-- rounding bug. The anon weight (/4) lives here; the badge threshold lives in
-- app config. (A STORED generated column referencing sibling columns is valid in
-- Postgres 17.)
-- ---------------------------------------------------------------------------
alter table public.reports add column verified_count int not null default 0;
alter table public.reports add column anon_count     int not null default 0;
alter table public.reports
  add column priority_score int generated always as (verified_count + anon_count / 4) stored;

-- ---------------------------------------------------------------------------
-- (c) report_validations_recount — recompute trigger. Mirrors
-- refresh_report_visibility: lock the report row (serialize concurrent
-- recomputes), recount both buckets from scratch, and UPDATE only when a count
-- actually changed. DEFINER + search_path='' (hardened-DEFINER convention).
--
-- Terminates (no cycle): it fires on report_validations and only UPDATEs reports;
-- that UPDATE fires the existing reports_set_updated_at BEFORE trigger (harmless)
-- but NO validation trigger, so the chain ends there.
-- ---------------------------------------------------------------------------
create or replace function public.report_validations_recount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id uuid;
  v_verified  int;
  v_anon      int;
begin
  v_report_id := coalesce(new.report_id, old.report_id);

  -- Serialize concurrent recomputes for the same report so each sees the other
  -- writer's committed sibling state (closes the dual-writer READ COMMITTED race).
  perform 1 from public.reports where id = v_report_id for no key update;

  select count(*) filter (where validator_id is not null),
         count(*) filter (where validator_id is null)
    into v_verified, v_anon
  from public.report_validations
  where report_id = v_report_id;

  update public.reports
     set verified_count = v_verified,
         anon_count     = v_anon
   where id = v_report_id
     and (verified_count is distinct from v_verified
          or anon_count is distinct from v_anon);  -- only write when it changes

  return null;  -- AFTER trigger
end;
$$;

revoke execute on function public.report_validations_recount() from public, anon, authenticated;

create trigger report_validations_recount_trg
  after insert or delete on public.report_validations
  for each row execute function public.report_validations_recount();

-- ---------------------------------------------------------------------------
-- (d) reports_seed_author_validation — the report author is an IMPLICIT verified
-- validation. AFTER INSERT on reports, when reporter_id is set, insert a verified
-- row for the author; that INSERT fires the recount -> verified_count = 1.
-- Anonymous reports (no reporter_id) start at 0. ON CONFLICT DO NOTHING is
-- belt-and-braces (the author can't already have a row on a fresh report).
-- ---------------------------------------------------------------------------
create or replace function public.reports_seed_author_validation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reporter_id is not null then
    insert into public.report_validations (report_id, validator_id)
    values (new.id, new.reporter_id)
    on conflict do nothing;
  end if;
  return null;  -- AFTER trigger
end;
$$;

revoke execute on function public.reports_seed_author_validation() from public, anon, authenticated;

create trigger reports_seed_author_validation_trg
  after insert on public.reports
  for each row execute function public.reports_seed_author_validation();

-- ---------------------------------------------------------------------------
-- (e) validate_report — the ONLY client write path into report_validations.
-- DEFINER + search_path='' so it can insert past the (intentionally
-- insert-policy-less) RLS. It gates validatability, inserts the right identity
-- row, dedups via ON CONFLICT DO NOTHING, and returns the FRESH counts read from
-- reports (NOT via INSERT ... RETURNING — that sidesteps the restrictive-SELECT
-- trap that bit subsystem B).
-- ---------------------------------------------------------------------------
create or replace function public.validate_report(
  p_report_id uuid,
  p_ip_hash   text
)
returns table(verified_count int, anon_count int, newly_added boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_rows  int;
  v_newly boolean;
begin
  -- Validatability gate: the target must exist, be open (nuevo|en_proceso) AND
  -- visible. A resuelto/descartado/hidden report is not corroborable (-> 409).
  if not exists (
    select 1 from public.reports
    where id = p_report_id
      and status in ('nuevo', 'en_proceso')
      and is_visible
  ) then
    raise exception 'report not validatable' using errcode = 'P0001';
  end if;

  -- Identity: authenticated -> verified row; otherwise -> anonymous row keyed by
  -- a non-empty ip_hash. ON CONFLICT DO NOTHING makes re-confirm idempotent.
  if v_uid is not null then
    insert into public.report_validations (report_id, validator_id)
    values (p_report_id, v_uid)
    on conflict do nothing;
  else
    if p_ip_hash is null or length(btrim(p_ip_hash)) = 0 then
      raise exception 'ip_hash required' using errcode = '22023';
    end if;
    insert into public.report_validations (report_id, ip_hash)
    values (p_report_id, p_ip_hash)
    on conflict do nothing;
  end if;

  get diagnostics v_rows = row_count;
  v_newly := v_rows > 0;

  -- Return the FRESH counts (the recount trigger fired on the insert above).
  return query
  select r.verified_count, r.anon_count, v_newly
  from public.reports r
  where r.id = p_report_id;
end;
$$;

-- Anon EXECUTE is INTENTIONAL — anonymous corroboration is a product goal; the
-- captcha + rate-limit gates live in the API route, not the DB. Granted by full
-- signature.
revoke execute on function public.validate_report(uuid, text) from public;
grant execute on function public.validate_report(uuid, text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- (f) RLS — grants gate verbs, RLS gates rows (the 0003/0014 posture). SELECT is
-- granted to anon + authenticated; INSERT/UPDATE/DELETE are deliberately NOT
-- granted to clients (only the DEFINER RPC/triggers write). NO insert policy.
-- SELECT policies: own (the "did I validate" check) + admin (moderation). An
-- anonymous caller (auth.uid() null, not admin) matches no policy -> 0 rows
-- (cannot enumerate).
-- ---------------------------------------------------------------------------
grant select on public.report_validations to anon, authenticated;

alter table public.report_validations enable row level security;

create policy report_validations_select_own on public.report_validations
  for select to anon, authenticated
  using (validator_id = (select auth.uid()));

create policy report_validations_select_admin on public.report_validations
  for select to anon, authenticated
  using (private.is_admin());

-- ---------------------------------------------------------------------------
-- (g) reports_in_view v3 — adds verified_count / anon_count for the map popup
-- (counts + derived badge). IDENTICAL to v2 (0015) otherwise: same bbox
-- validation, joins, WHERE, ORDER, limit, and SECURITY INVOKER (anon runs under
-- RLS; reports_select_public already exposes the visible rows). The return shape
-- changes (2 new columns), and Postgres forbids changing a return type via
-- create or replace, so it is DROPped then re-CREATEd, and grants re-asserted.
-- ---------------------------------------------------------------------------
drop function if exists public.reports_in_view(float, float, float, float, int);

create function public.reports_in_view(
  min_lng float,
  min_lat float,
  max_lng float,
  max_lat float,
  p_limit int default 2000
)
returns table (
  id                 uuid,
  lng                float,
  lat                float,
  category           text,
  status             public.report_status,
  created_at         timestamptz,
  claimed_by_handle  text,
  claimed_by_type    text,
  resolved_by_handle text,
  resolved_by_type   text,
  verified_count     int,
  anon_count         int
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- Enforce the bbox invariants in the DB itself (the anon key can call this
  -- directly, bypassing the HTTP parseBbox). Order mirrors parseBbox: range,
  -- then ordering, then the anti-abuse area cap.
  if min_lng < -180 or min_lng > 180 or max_lng < -180 or max_lng > 180
     or min_lat < -90 or min_lat > 90 or max_lat < -90 or max_lat > 90 then
    raise exception 'invalid bbox: coordinates out of range';
  end if;
  if min_lng >= max_lng or min_lat >= max_lat then
    raise exception 'invalid bbox: min must be < max';
  end if;
  if max_lng - min_lng > 5 or max_lat - min_lat > 5 then
    raise exception 'bbox too large';
  end if;

  return query
  select
    r.id,
    extensions.st_x(r.location::extensions.geometry) as lng,
    extensions.st_y(r.location::extensions.geometry) as lat,
    c.slug as category,
    r.status,
    r.created_at,
    spc.handle as claimed_by_handle,
    spc.type   as claimed_by_type,
    spr.handle as resolved_by_handle,
    spr.type   as resolved_by_type,
    r.verified_count,
    r.anon_count
  from public.reports r
  join public.categories c on c.id = r.category_id
  left join public.solver_profiles spc on spc.id = r.claimed_by
  left join public.solver_profiles spr on spr.id = r.resolved_by
  where r.is_visible = true
    -- geography envelope so `&&` is served by the geography GIST index.
    and r.location operator(extensions.&&)
        extensions.st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)::extensions.geography
    -- only true points carry meaningful lng/lat.
    and extensions.geometrytype(r.location::extensions.geometry) = 'POINT'
  -- deterministic newest-first order so caching + truncation are stable.
  order by r.created_at desc, r.id
  limit p_limit;
end;
$$;

revoke execute on function public.reports_in_view(float, float, float, float, int)
  from public;
grant execute on function public.reports_in_view(float, float, float, float, int)
  to anon, authenticated, service_role;
