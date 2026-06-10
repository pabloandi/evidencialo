-- resolution_media_test.sql — attach_resolution_media DEFINER RPC (pgTAP).
-- Run with: supabase test db
--
-- Arbiter for chunk B2.2a (attach resolution proof to an EXISTING report,
-- solver-resolution.scenarios.md SCEN-002 + the universal-gate design). Covers:
--   * a SOLVER attaches 1 media → returns 1 row; the DB has a kind='resolution'
--     row with uploaded_by=solver, processing_state='pending', storage_path
--     under `<R1>/resolution/`
--   * a STAFF attaches → succeeds (staff retain resolve powers → must supply proof)
--   * a CITIZEN attaches → 42501; nothing inserted
--   * attaching to an unknown report id → P0002; no orphan row
--   * attaching a PENDING resolution proof does NOT un-publish a visible report
--     (visibility trigger v2 ignores kind='resolution' — blocker #1 regression)
--   * grants: authenticated has EXECUTE, anon does NOT
--
-- Identity is switched with `set local role authenticated` + `request.jwt.claims`
-- (sub) exactly like solver_resolution_test.sql; the DEFINER function runs but
-- its internal is_staff()/is_solver() gates read auth.uid() from those claims.
-- The RPC calls + throws_ok run UNDER the role (they need it for the authz gate),
-- but every state-read assertion runs AFTER `reset role` as the superuser —
-- otherwise RLS hides the (non-visible) reports from the authenticated role.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(14);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS).
--   CITIZEN 1111… (role citizen), SOLVER 5555… (promoted + solver_profiles),
--   STAFF 7777… (role staff).
--   R1  nuevo — the main attach subject
--   R3  visible (has a processed kind='report' media) — visibility regression
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'citizen@test.local'),
  ('00000000-0000-0000-0000-000000000000', '55555555-5555-5555-5555-555555555555', 'authenticated', 'authenticated', 'solver@test.local'),
  ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777777', 'authenticated', 'authenticated', 'staff@test.local');

-- handle_new_user created profiles (role citizen). Promote the solver + give it
-- a public solver profile; promote the staff member.
update public.profiles set role = 'solver' where id = '55555555-5555-5555-5555-555555555555';
insert into public.solver_profiles (id, handle, type)
  values ('55555555-5555-5555-5555-555555555555', 'alcaldia-cali', 'government');
update public.profiles set role = 'staff' where id = '77777777-7777-7777-7777-777777777777';

-- R1: nuevo with a citizen reporter — the main attach subject.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', c.id, 'nuevo',
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

-- R3: nuevo; a processed kind='report' media makes the trigger publish it.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'a3333333-3333-3333-3333-333333333333', null, c.id, 'nuevo',
       'SRID=4326;POINT(-74.08 4.63)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

insert into public.report_media (report_id, storage_path, type, processing_state, kind)
  values ('a3333333-3333-3333-3333-333333333333', 'a333/report.jpg', 'image', 'processed', 'report');

-- ===========================================================================
-- A SOLVER attaches 1 resolution media to R1. RPC under the role; state reads
-- after reset role (superuser bypasses RLS on the non-visible report).
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select is(
  jsonb_array_length(
    (public.attach_resolution_media(
      'a1111111-1111-1111-1111-111111111111',
      '[{"storage_path": "0.jpg", "type": "image", "duration_s": null}]'::jsonb
    )) -> 'media'
  ),
  1,
  'solver: attaching 1 media returns a 1-element media array');
reset role;

select is(
  (select count(*) from public.report_media
   where report_id = 'a1111111-1111-1111-1111-111111111111' and kind = 'resolution')::int,
  1,
  'solver: exactly one kind=resolution row is persisted for R1');

select is(
  (select uploaded_by from public.report_media
   where report_id = 'a1111111-1111-1111-1111-111111111111' and kind = 'resolution'),
  '55555555-5555-5555-5555-555555555555'::uuid,
  'solver: uploaded_by equals the solver auth.uid() (no client-supplied attribution)');

select is(
  (select processing_state from public.report_media
   where report_id = 'a1111111-1111-1111-1111-111111111111' and kind = 'resolution'),
  'pending'::public.media_processing_state,
  'solver: the resolution row is born pending (processor flips it to processed)');

select is(
  (select storage_path from public.report_media
   where report_id = 'a1111111-1111-1111-1111-111111111111' and kind = 'resolution'),
  'a1111111-1111-1111-1111-111111111111/resolution/0.jpg',
  'solver: storage_path is namespaced under <R1>/resolution/ (never collides with complaint media)');

-- ===========================================================================
-- A STAFF member attaches proof — staff retain resolve powers, so they must be
-- able to supply proof too (universal gate).
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'authenticated')::text, true);
select is(
  jsonb_array_length(
    (public.attach_resolution_media(
      'a1111111-1111-1111-1111-111111111111',
      '[{"storage_path": "1.jpg", "type": "image", "duration_s": null}]'::jsonb
    )) -> 'media'
  ),
  1,
  'staff: attaching proof succeeds (staff retain resolve powers)');
reset role;

-- ===========================================================================
-- A CITIZEN attaches → 42501; nothing inserted on their behalf.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.attach_resolution_media('a1111111-1111-1111-1111-111111111111',
       '[{"storage_path": "9.jpg", "type": "image", "duration_s": null}]'::jsonb) $$,
  '42501',
  'forbidden',
  'citizen: attaching resolution media raises forbidden (42501)');
reset role;

select is(
  (select count(*) from public.report_media
   where report_id = 'a1111111-1111-1111-1111-111111111111'
     and kind = 'resolution'
     and uploaded_by = '11111111-1111-1111-1111-111111111111'::uuid)::int,
  0,
  'citizen: nothing was inserted (no row attributed to the citizen)');

-- ===========================================================================
-- Attaching to an unknown report id → P0002; no orphan media row created.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.attach_resolution_media('aaaaaaaa-0000-0000-0000-000000000000',
       '[{"storage_path": "0.jpg", "type": "image", "duration_s": null}]'::jsonb) $$,
  'P0002',
  'report not found',
  'unknown report: attaching raises not-found (P0002)');
reset role;

select is(
  (select count(*) from public.report_media
   where report_id = 'aaaaaaaa-0000-0000-0000-000000000000')::int,
  0,
  'unknown report: no orphan media row is created');

-- ===========================================================================
-- Visibility-trigger v2 regression (blocker #1): R3 is visible via a processed
-- kind='report' media; attaching a PENDING kind='resolution' proof must NOT
-- un-publish it. RPC under the solver role; reads as superuser.
-- ===========================================================================
select is(
  (select is_visible from public.reports where id = 'a3333333-3333-3333-3333-333333333333'),
  true,
  'trigger v2: R3 is visible (its only report media is processed)');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select count(*) from public.attach_resolution_media(
  'a3333333-3333-3333-3333-333333333333',
  '[{"storage_path": "0.jpg", "type": "image", "duration_s": null}]'::jsonb);
reset role;

select is(
  (select is_visible from public.reports where id = 'a3333333-3333-3333-3333-333333333333'),
  true,
  'trigger v2: attaching a PENDING resolution proof does NOT un-publish the visible report');

-- ===========================================================================
-- Grants: authenticated may EXECUTE; anon never can (else linter 0028 fires).
-- ===========================================================================
select is(
  has_function_privilege('authenticated', 'public.attach_resolution_media(uuid, jsonb)', 'EXECUTE'),
  true,
  'grants: authenticated has EXECUTE on attach_resolution_media');

select is(
  has_function_privilege('anon', 'public.attach_resolution_media(uuid, jsonb)', 'EXECUTE'),
  false,
  'grants: anon does NOT have EXECUTE on attach_resolution_media');

select * from finish();
rollback;
