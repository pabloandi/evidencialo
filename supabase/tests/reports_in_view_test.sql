-- reports_in_view tests (pgTAP). Run with: supabase test db
-- Encodes the public-map-bbox holdout (public-map-bbox.scenarios.md) at the DB
-- level: the bbox read returns ONLY visible reports inside the box, with public
-- fields only.
--   SCEN-001 (E8): a visible report INSIDE the box is returned; a visible
--                  report OUTSIDE is not.
--   SCEN-002 (E2): an is_visible=false report INSIDE the box is excluded.
--   SCEN-004:      the returned columns are exactly the public set
--                  (id, lng, lat, category, status, created_at) — no reporter_id.
-- Plus grants: anon/authenticated/service_role may EXECUTE; public may not.
--
-- Seeded as superuser (bypasses RLS). Fixed UUIDs, category 'bache'. Reports
-- are visibility-set EXPLICITLY here (we set is_visible directly) so the test
-- exercises reports_in_view's own filter, independent of the media trigger.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

select plan(17);

-- ---------------------------------------------------------------------------
-- Fixtures. Box under test: lng [-74.10,-74.06], lat [4.60,4.62].
--   A  visible   INSIDE  (-74.08, 4.61)  -> expected present
--   B  visible   OUTSIDE (-75.50, 6.25)  -> expected absent
--   C  invisible INSIDE  (-74.08, 4.615) -> expected absent
-- ---------------------------------------------------------------------------
insert into public.reports (id, category_id, location, is_visible)
select r.id, c.id, r.loc, r.vis
from public.categories c
cross join (values
  ('a0000000-0000-0000-0000-0000000000aa'::uuid, 'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true),  -- A
  ('b0000000-0000-0000-0000-0000000000bb'::uuid, 'SRID=4326;POINT(-75.50 6.25)'::extensions.geography, true),  -- B
  ('c0000000-0000-0000-0000-0000000000cc'::uuid, 'SRID=4326;POINT(-74.08 4.615)'::extensions.geography, false) -- C
) as r(id, loc, vis)
where c.slug = 'bache';

-- ===========================================================================
-- SCEN-001 (E8): A (visible, inside) is in the result.
-- ===========================================================================
select ok(
  exists (
    select 1 from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
    where id = 'a0000000-0000-0000-0000-0000000000aa'
  ),
  'SCEN-001: visible report INSIDE the box is returned'
);

-- SCEN-001 (E8): B (visible, outside) is NOT in the result.
select ok(
  not exists (
    select 1 from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
    where id = 'b0000000-0000-0000-0000-0000000000bb'
  ),
  'SCEN-001: visible report OUTSIDE the box is excluded'
);

-- ===========================================================================
-- SCEN-002 (E2): C (invisible, inside) is NOT in the result.
-- ===========================================================================
select ok(
  not exists (
    select 1 from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
    where id = 'c0000000-0000-0000-0000-0000000000cc'
  ),
  'SCEN-002: invisible report INSIDE the box is excluded'
);

-- ===========================================================================
-- SCEN-004: public field set + values. A's row carries id, lng, lat, category
-- slug, status, created_at — and the column set is exactly those six.
-- ===========================================================================
select is(
  (select category from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
   where id = 'a0000000-0000-0000-0000-0000000000aa'),
  'bache',
  'SCEN-004: category is the slug'
);

select is(
  (select status from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
   where id = 'a0000000-0000-0000-0000-0000000000aa'),
  'nuevo'::public.report_status,
  'SCEN-004: status default is exposed'
);

-- lng/lat round-trip the stored point (tolerance for float).
select cmp_ok(
  (select abs(lng - (-74.08)) from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
   where id = 'a0000000-0000-0000-0000-0000000000aa'),
  '<', 0.0001::float,
  'SCEN-004: lng round-trips the stored point'
);
select cmp_ok(
  (select abs(lat - 4.61) from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
   where id = 'a0000000-0000-0000-0000-0000000000aa'),
  '<', 0.0001::float,
  'SCEN-004: lat round-trips the stored point'
);

-- The function's RETURNS TABLE column set is exactly the public set (no
-- reporter_id / no address can leak because they are not declared). Zip
-- proargnames with proargmodes from pg_proc and keep the TABLE output columns
-- (mode 't'); the four IN args (mode 'i') are excluded.
select set_eq(
  $$ select a.name
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'public'
       and p.proname = 'reports_in_view'
       and a.mode = 't' $$,
  $$ values ('id'), ('lng'), ('lat'), ('category'), ('status'), ('created_at'),
            ('claimed_by_handle'), ('claimed_by_type'),
            ('resolved_by_handle'), ('resolved_by_type'),
            ('verified_count'), ('anon_count') $$,
  'SCEN-004: TABLE OUT columns are exactly the public set + solver attribution + corroboration counts (no reporter_id/address)'
);

-- ===========================================================================
-- Grants: anon may EXECUTE (the map is open); PUBLIC may not (revoked).
-- ===========================================================================
select ok(
  has_function_privilege(
    'anon',
    'public.reports_in_view(float, float, float, float, int)',
    'EXECUTE'
  ),
  'grant: anon can EXECUTE reports_in_view'
);

-- Security context: the function is SECURITY INVOKER (0010 hardening), so an
-- anon caller runs under RLS, not the owner's privileges. A regression back to
-- DEFINER (the linter-flagged form) must fail here. `prosecdef = false` = INVOKER.
select ok(
  not (select p.prosecdef
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'reports_in_view'),
  'security: reports_in_view is SECURITY INVOKER (not DEFINER)'
);

-- ===========================================================================
-- SCEN-H01: the bbox query is served by the geography GIST index, NOT a seq
-- scan. The function body is plpgsql (not directly EXPLAIN-able), so we EXPLAIN
-- the exact geography-envelope predicate the body runs. enable_seqscan is forced
-- OFF so the planner cannot fall back to a cheap seq scan on the tiny test
-- table; a geometry-cast predicate (the bug) could NOT use the geography index
-- even then. A helper captures the EXPLAIN text into one string we assert on.
-- ===========================================================================
create or replace function pg_temp.explain_bbox() returns text
language plpgsql as $fn$
declare
  ln   text;
  acc  text := '';
begin
  set local enable_seqscan = off;
  for ln in
    execute $q$
      explain (format text)
      select r.id from public.reports r
      where r.is_visible = true
        and r.location operator(extensions.&&)
            extensions.st_makeenvelope(-74.10, 4.60, -74.06, 4.62, 4326)::extensions.geography
    $q$
  loop
    acc := acc || ln || E'\n';
  end loop;
  return acc;
end;
$fn$;

-- This pgTAP build ships only the SQL `like` operator (no like()/matches()
-- diagnostic functions), so assert via ok() over a boolean LIKE expression.
select ok(
  pg_temp.explain_bbox() like '%reports_location_gix%',
  'SCEN-H01: EXPLAIN uses an index scan on reports_location_gix'
);

select ok(
  pg_temp.explain_bbox() not like '%Seq Scan%',
  'SCEN-H01: EXPLAIN does NOT fall back to a Seq Scan on reports'
);

-- ===========================================================================
-- SCEN-H02: the RPC enforces the bbox invariants itself (the anon key can call
-- it directly, bypassing the HTTP parseBbox). A world box, an inverted box, and
-- an out-of-range box each RAISE; a valid city box still returns rows.
-- ===========================================================================
select throws_ok(
  $$ select * from public.reports_in_view(-180, -90, 180, 90) $$,
  'bbox too large',
  'SCEN-H02: a whole-world (>5° span) box raises'
);

select throws_ok(
  $$ select * from public.reports_in_view(-74.06, 4.62, -74.10, 4.60) $$,
  'invalid bbox: min must be < max',
  'SCEN-H02: an inverted (min>=max) box raises'
);

select throws_ok(
  $$ select * from public.reports_in_view(-200, 4.60, -74.06, 4.62) $$,
  'invalid bbox: coordinates out of range',
  'SCEN-H02: an out-of-range box raises'
);

select isnt_empty(
  $$ select id from public.reports_in_view(-74.10, 4.60, -74.06, 4.62) $$,
  'SCEN-H02: a valid city box still returns rows'
);

-- ===========================================================================
-- SCEN-H03 (DB-observable half): rows come back NEWEST-first by created_at.
-- Seed two visible reports inside the box with distinct created_at and assert
-- the newer one precedes the older. (The truncation HEADER signal is asserted
-- in the integration test, which can inject a small p_limit.)
-- ===========================================================================
insert into public.reports (id, category_id, location, is_visible, created_at)
select r.id, c.id, r.loc, true, r.ts
from public.categories c
cross join (values
  ('d0000000-0000-0000-0000-0000000000d1'::uuid, 'SRID=4326;POINT(-74.08 4.611)'::extensions.geography, '2026-01-01T00:00:00Z'::timestamptz), -- older
  ('d0000000-0000-0000-0000-0000000000d2'::uuid, 'SRID=4326;POINT(-74.08 4.612)'::extensions.geography, '2026-02-01T00:00:00Z'::timestamptz)  -- newer
) as r(id, loc, ts)
where c.slug = 'bache';

select is(
  (select array_agg(id order by ord)
   from (
     select id, row_number() over () as ord
     from public.reports_in_view(-74.10, 4.60, -74.06, 4.62)
     where id in ('d0000000-0000-0000-0000-0000000000d1',
                  'd0000000-0000-0000-0000-0000000000d2')
   ) s),
  array['d0000000-0000-0000-0000-0000000000d2'::uuid,
        'd0000000-0000-0000-0000-0000000000d1'::uuid],
  'SCEN-H03: rows are newest-first (created_at desc)'
);

select * from finish();
rollback;
