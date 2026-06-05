-- 0009_reports_in_view.sql
-- Public bounding-box read for the open map (step11) + review hardening
-- (public-map-bbox-hardening.scenarios.md, SCEN-H01..H03).
--
-- The public map reads visible reports inside the current viewport. This
-- function is the single PostGIS read path: it filters reports by a bbox using
-- the existing geography GIST index `reports_location_gix` (0002) and returns
-- ONLY `is_visible = true` rows with PUBLIC fields only — never `reporter_id`,
-- never the precise street `address`. The pin coordinates are public by nature
-- of a map marker, so lng/lat are exposed; nothing else PII-bearing is.
--
-- INDEX USAGE (SCEN-H01 — CRITICAL fix): `reports.location` is GEOGRAPHY and the
-- GIST index is a geography index. The first cut compared it against a GEOMETRY
-- envelope (ST_SetSRID(ST_MakeBox2D(...))), which forced `location::geometry` and
-- made the index unusable → a full seq scan. The predicate now builds a
-- GEOGRAPHY envelope with ST_MakeEnvelope(...)::geography, so `location && env`
-- is served directly by `reports_location_gix` (verified via EXPLAIN with
-- enable_seqscan=off: Index Scan on reports_location_gix).
--
-- IN-RPC INVARIANTS (SCEN-H02 — HIGH fix): the anon role can call this RPC
-- DIRECTLY, bypassing the route's parseBbox cap. The database is therefore the
-- real security boundary: the function itself rejects an inverted box, an
-- out-of-range box, or an over-large (>5° span) box. The HTTP parseBbox 400 is
-- only the fast first line of defense.
--
-- DETERMINISTIC TRUNCATION (SCEN-H03 — HIGH fix): a dense viewport is capped at
-- `p_limit` rows, ordered NEWEST-first (created_at desc, id) so a cached response
-- is stable and the truncation (when it happens) drops the OLDEST pins, not a
-- random set. The caller passes `p_limit = limit + 1` to detect truncation.
--
-- NON-POINT GUARD (FIX D): a malformed non-point/degenerate geometry is excluded
-- (geometrytype = 'POINT'), so a row can never surface as {lng:null, lat:null}.
--
-- Security: SECURITY DEFINER with `search_path = ''` (every reference fully
-- qualified; PostGIS lives in `extensions`). The explicit `r.is_visible = true`
-- predicate makes the visible-only contract hold regardless of RLS. DEFINER here
-- exposes ONLY already-public, visible data; a security-advisor review of
-- "function with elevated privileges" should note the body reads public columns
-- gated on is_visible, not a privilege escalation. EXECUTE is granted to
-- anon/authenticated/service_role because the map is open to everyone.
-- Drop any prior 4-arg signature first: adding `p_limit int default 2000`
-- creates a DISTINCT signature, and leaving the old 4-arg function in place
-- would make a 4-arg call ambiguous. This migration has not been applied to
-- remote yet, so an in-place rewrite is safe; the IF EXISTS keeps a fresh
-- `db reset` (which never had the 4-arg form) clean too.
drop function if exists public.reports_in_view(float, float, float, float);

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
security definer
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

-- Both the 4-arg (original SCEN-001..004 holdout signature) and 5-arg overloads
-- resolve to the same function body because p_limit has a default; grants below
-- name the full signature.
revoke execute on function public.reports_in_view(float, float, float, float, int)
  from public;
grant execute on function public.reports_in_view(float, float, float, float, int)
  to anon, authenticated, service_role;
