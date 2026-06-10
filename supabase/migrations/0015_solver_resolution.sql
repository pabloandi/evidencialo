-- 0015_solver_resolution.sql
-- Subsystem B, chunk B2.1: resolution lifecycle & public attribution (DB layer).
--
-- This migration opens the staff-only status workflow to verified solvers and
-- records WHO claimed/resolved a report plus the PROOF that it was fixed. It is
-- the data foundation the B2 API/UI (claim/resolve controls, before/after,
-- attribution badges, /solucionadores/[handle]) build on.
--
-- What it adds, in order:
--   (a) reports.claimed_by/claimed_at/resolved_by — attribution as uuid FKs to
--       profiles(id); the public handle/type come from a JOIN to solver_profiles,
--       never denormalized onto reports.
--   (b) report_media.kind ('report'|'resolution') + uploaded_by — distinguishes
--       the original complaint media from the resolution proof. `kind` defaults
--       to 'report' so every existing row backfills as report media (correct),
--       THEN the CHECK is added.
--   (c) refresh_report_visibility v2 — scopes the is_visible recompute to
--       kind='report' ONLY (blocker #1): attaching a `pending` resolution proof
--       must NOT un-publish a visible report.
--   (d) change_report_status v2 — same signature, adds the solver branch
--       (claim → en_proceso, resolve → resuelto) + the UNIVERSAL proof gate on
--       → resuelto (any caller, staff or solver, needs processed resolution proof).
--   (e) reports_in_view v2 — returns the claim/resolve handle+type (LEFT JOIN to
--       solver_profiles) for the map popup. Its return shape changes, so it is
--       DROPped then re-CREATEd (Postgres forbids changing return type via
--       create or replace), then grants are re-asserted.

-- ---------------------------------------------------------------------------
-- (a) reports: attribution columns. uuid FKs to profiles(id); the
-- handle/type are joined from solver_profiles at read time (NOT denormalized).
-- resolved_at already exists (0002) — do not add it.
-- ---------------------------------------------------------------------------
alter table public.reports
  add column claimed_by  uuid references public.profiles (id),
  add column claimed_at  timestamptz,
  add column resolved_by uuid references public.profiles (id);

-- ---------------------------------------------------------------------------
-- (b) report_media: kind + uploaded_by. Add `kind` WITH a default first so the
-- existing rows backfill to 'report' (they are all complaint media), THEN add
-- the CHECK — adding the constraint after the default-backed column avoids a
-- violation on the existing rows.
-- ---------------------------------------------------------------------------
alter table public.report_media add column kind text not null default 'report';
alter table public.report_media add constraint report_media_kind_check
  check (kind in ('report', 'resolution'));
alter table public.report_media add column uploaded_by uuid references public.profiles (id);

-- ---------------------------------------------------------------------------
-- (c) refresh_report_visibility v2 — IDENTICAL to 0007 EXCEPT both subqueries
-- are scoped to kind='report'. Visibility is a property of the COMPLAINT media
-- only: a report is visible iff it has >=1 processed report-media and none of
-- its REPORT media is pending/failed. A resolution proof (kind='resolution')
-- that is still `pending` (e.g. a proof video mid-sanitize) must NOT drag a
-- published report back to invisible — that is blocker #1. `create or replace`
-- keeps the existing report_media_visibility trigger binding; the lock, DEFINER,
-- search_path='' and the revoke all carry over unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_report_visibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id uuid;
  v_visible   boolean;
begin
  v_report_id := coalesce(new.report_id, old.report_id);

  -- Serialize concurrent recomputes for the same report so each sees the other
  -- writer's committed sibling state (closes the dual-writer READ COMMITTED race
  -- that would otherwise strand the report invisible). Taken BEFORE the select.
  perform 1 from public.reports where id = v_report_id for no key update;

  -- Visible iff the report has at least one REPORT media row and NONE of its
  -- REPORT media are pending/failed. Resolution proof media (kind='resolution')
  -- is intentionally out of scope: attaching a pending proof must not un-publish.
  select exists (select 1 from public.report_media
                 where report_id = v_report_id and kind = 'report')
     and not exists (select 1 from public.report_media
                     where report_id = v_report_id
                       and kind = 'report'
                       and processing_state in ('pending', 'failed'))
    into v_visible;

  update public.reports
     set is_visible = v_visible
   where id = v_report_id
     and is_visible is distinct from v_visible;  -- only write when it changes

  return null;  -- AFTER trigger
end;
$$;

revoke execute on function public.refresh_report_visibility() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (d) change_report_status v2 — SAME signature + return shape as 0011, so
-- `create or replace` preserves the grants and PostgREST exposure. Extends the
-- staff-only path with a solver branch and a UNIVERSAL resolution-proof gate.
--
-- Contract changes vs 0011:
--   * Authz now admits solvers too. A solver who is NOT staff may ONLY move a
--     report to en_proceso (claim) or resuelto (resolve) — never descartado or
--     back to nuevo (SCEN-004). Staff/admin retain every transition.
--   * UNIVERSAL proof gate: ANY caller moving a report to `resuelto` must have
--     >=1 processed kind='resolution' media for it, else P0001 (no empty resolved
--     claims). This is an intentional contract tightening for staff too.
--   * Attribution: a real transition INTO en_proceso stamps claimed_by/claimed_at
--     = auth.uid()/now(); INTO resuelto stamps resolved_by/resolved_at. All from
--     auth.uid() inside the body — never a client arg (SCEN-006, no forgery).
--   * First-claimer-wins (MVP): the no-op guard (v_from = p_to_status → return)
--     is kept verbatim, so a same-status re-claim does NOT overwrite claimed_by.
--   * resolved_at semantics preserved from 0011: stamped on → resuelto, never
--     cleared on un-resolve (the dispute-revert path in B3 nulls it explicitly).
--
-- DEFINER + the is_staff/is_solver gate as the first writes => its own security
-- boundary (pre-empts the 0029 advisor); grants re-asserted by name below.
-- ---------------------------------------------------------------------------
create or replace function public.change_report_status(
  p_report_id uuid,
  p_to_status public.report_status,
  p_note text default null
)
returns table(id uuid, status public.report_status, resolved_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from      public.report_status;
  v_is_staff  boolean := private.is_staff();
  v_is_solver boolean := private.is_solver();
begin
  -- DB-layer authz: only staff/admin OR a verified solver may change status.
  if not (v_is_staff or v_is_solver) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Solver scope: a solver who is not also staff may ONLY claim (en_proceso) or
  -- resolve (resuelto). descartado / nuevo stay staff/admin-only (SCEN-004).
  if v_is_solver and not v_is_staff
     and p_to_status not in ('en_proceso', 'resuelto') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Lock the row and capture the pre-change status for the audit's from_status.
  -- A missing report is a not-found condition the route maps to 404.
  select r.status into v_from
  from public.reports r
  where r.id = p_report_id
  for update;

  if not found then
    raise exception 'report not found' using errcode = 'P0002';
  end if;

  -- No-op: the requested status equals the current one. Do not write a junk
  -- audit row, do not re-stamp resolved_at, and (MVP first-claimer-wins) do not
  -- overwrite claimed_by on a same-status re-claim; return the current row so
  -- the UI still refreshes cleanly. (SCEN-H01)
  if v_from = p_to_status then
    return query
      select r.id, r.status, r.resolved_at
      from public.reports r
      where r.id = p_report_id;
    return;
  end if;

  -- Universal proof gate: NO report reaches `resuelto` without >=1 processed
  -- resolution proof media — staff and solvers alike (no empty resolved claims).
  if p_to_status = 'resuelto'
     and not exists (
       select 1 from public.report_media
       where report_id = p_report_id
         and kind = 'resolution'
         and processing_state = 'processed'
     ) then
    raise exception 'resolution proof required' using errcode = 'P0001';
  end if;

  -- Apply the change. Attribution is set ONLY on the real transition INTO the
  -- relevant status, from auth.uid() (never a client arg). resolved_at follows
  -- 0011 semantics: stamped on → resuelto, otherwise left untouched.
  update public.reports
  set status      = p_to_status,
      updated_at  = now(),
      claimed_by  = case when p_to_status = 'en_proceso' then (select auth.uid()) else reports.claimed_by end,
      claimed_at  = case when p_to_status = 'en_proceso' then now() else reports.claimed_at end,
      resolved_at = case when p_to_status = 'resuelto' then now() else reports.resolved_at end,
      resolved_by = case when p_to_status = 'resuelto' then (select auth.uid()) else reports.resolved_by end
  where reports.id = p_report_id;

  -- Audit row — inseparable from the update above (same transaction).
  -- A blank/whitespace note collapses to NULL.
  insert into public.report_status_history (report_id, from_status, to_status, changed_by, note)
  values (
    p_report_id,
    v_from,
    p_to_status,
    (select auth.uid()),
    nullif(btrim(coalesce(p_note, '')), '')
  );

  -- Echo the new row so the API can return it without a second read.
  return query
  select r.id, r.status, r.resolved_at
  from public.reports r
  where r.id = p_report_id;
end;
$$;

-- Only authenticated callers may invoke it; anon never can. The internal
-- is_staff/is_solver gate further restricts the effect. Supabase's default
-- privileges grant EXECUTE on public functions to anon, so anon is revoked BY
-- NAME (otherwise linter 0028 fires).
revoke execute on function public.change_report_status(uuid, public.report_status, text) from public, anon;
grant execute on function public.change_report_status(uuid, public.report_status, text) to authenticated;

-- ---------------------------------------------------------------------------
-- (e) reports_in_view v2 — adds claim/resolve attribution (handle + type) for
-- the map popup. The return shape changes (4 new columns), and Postgres forbids
-- changing a function's return type via `create or replace`, so it is DROPped
-- then re-CREATEd, and the grants are re-asserted afterward.
--
-- Attribution is a LEFT JOIN reports → solver_profiles on claimed_by/resolved_by
-- (NOT a denormalized column): unattributed reports return null handle/type and
-- the row set is otherwise identical to 0010. Kept SECURITY INVOKER — anon runs
-- under RLS; solver_profiles has public SELECT (0014) so the join works for anon.
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
  resolved_by_type   text
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
    spr.type   as resolved_by_type
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
