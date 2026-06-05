-- 0010_reports_in_view_invoker.sql
-- Security hardening of the public bbox read (step11): SECURITY DEFINER -> INVOKER.
--
-- WHY: 0009 shipped `reports_in_view` as SECURITY DEFINER granted to anon +
-- authenticated. The database linter flagged it (0028/0029 —
-- "Public/Signed-In Can Execute SECURITY DEFINER Function"), and the warning is
-- correct: a DEFINER function callable by anon runs with the OWNER's privileges
-- and BYPASSES RLS, so the visible-only contract rests on the function body
-- alone. DEFINER bought us nothing here — the `reports` RLS for the public role
-- is already exactly `is_visible = true` (policy `reports_select_public`), and
-- `categories` is world-readable (`categories_select_all USING (true)`). So
-- INVOKER returns the IDENTICAL rows while ADDING the RLS layer on top of the
-- explicit predicate (defense in depth: anon must pass BOTH RLS and the body's
-- `r.is_visible = true`, instead of the body alone).
--
-- The explicit `r.is_visible = true` predicate stays: it keeps the visible-only
-- contract true even for RLS-exempt callers (the pgTAP suite runs as superuser
-- and the service-role integration client both bypass RLS), so the tests — and
-- the contract — are role-independent. SCEN-001..004 + SCEN-H01..H03 are
-- unchanged; this migration only flips the security context.
--
-- `create or replace` keeps the existing 5-arg signature and its grants; the
-- grants are re-asserted below for clarity. search_path = '' is retained.
create or replace function public.reports_in_view(
  min_lng float,
  min_lat float,
  max_lng float,
  max_lat float,
  p_limit int default 2000
)
returns table (
  id         uuid,
  lng        float,
  lat        float,
  category   text,
  status     public.report_status,
  created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- SCEN-H02: enforce the bbox invariants in the DB itself (the anon key can
  -- call this directly, bypassing the HTTP parseBbox). Order mirrors parseBbox:
  -- range, then ordering, then the anti-abuse area cap.
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
    r.created_at
  from public.reports r
  join public.categories c on c.id = r.category_id
  where r.is_visible = true
    -- SCEN-H01: geography envelope so `&&` is served by the geography GIST index.
    and r.location operator(extensions.&&)
        extensions.st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)::extensions.geography
    -- FIX D: only true points carry meaningful lng/lat.
    and extensions.geometrytype(r.location::extensions.geometry) = 'POINT'
  -- SCEN-H03: deterministic newest-first order so caching + truncation are stable.
  order by r.created_at desc, r.id
  limit p_limit;
end;
$$;

revoke execute on function public.reports_in_view(float, float, float, float, int)
  from public;
grant execute on function public.reports_in_view(float, float, float, float, int)
  to anon, authenticated, service_role;
