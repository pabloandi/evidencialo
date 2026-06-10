-- solver_resolution_test.sql — change_report_status v2 solver lifecycle (pgTAP).
-- Run with: supabase test db
--
-- Arbiter for chunk B2.1 (resolution lifecycle & attribution,
-- solver-resolution.scenarios.md). Covers SCEN-001..006 plus the blocker #1
-- visibility-trigger v2 regression:
--   SCEN-001  solver claim → en_proceso sets claimed_by = auth.uid() + claimed_at
--   SCEN-003  resolve without processed resolution proof raises P0001, status
--             unchanged  (asserted BEFORE any processed proof exists)
--   SCEN-002  solver resolve WITH proof → resuelto, resolved_by = auth.uid(),
--             resolved_at set, exactly one history row to_status='resuelto'
--   trigger   attaching a PENDING kind='resolution' proof to a VISIBLE report
--             leaves is_visible = true (the v2 fix; uses a dedicated report R3
--             so it never couples with the proof-gate test)
--   SCEN-004  citizen claim/resolve raise 42501; solver→descartado raises 42501;
--             status unchanged after each
--   SCEN-005  a report whose reporter_id is null is fully resolvable by a solver
--   SCEN-006  resolved_by equals the session uid (asserted in 002/005); the RPC
--             signature carries NO attribution param — exactly {p_report_id,
--             p_to_status, p_note}
--
-- Identity is switched with `set local role authenticated` +
-- `request.jwt.claims` (sub) exactly like change_report_status_test.sql; the
-- DEFINER function runs but its internal private.is_solver()/is_staff() gates
-- read auth.uid() from those claims. IMPORTANT (mirrors the sibling tests): the
-- RPC calls + throws_ok run UNDER the role (they need it for the authz gate),
-- but every state-read assertion runs AFTER `reset role` as the superuser —
-- otherwise RLS hides the (non-visible) reports from the authenticated role and
-- the reads come back NULL.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS).
--   CITIZEN 1111… (role citizen), SOLVER 5555… (promoted + solver_profiles).
--   R1  nuevo, reporter 1111…           — the main claim/resolve subject
--   R2  nuevo, reporter_id NULL          — SCEN-005 (anonymous report resolvable)
--   R3  visible (has a processed report media) — visibility-trigger regression
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'citizen@test.local'),
  ('00000000-0000-0000-0000-000000000000', '55555555-5555-5555-5555-555555555555', 'authenticated', 'authenticated', 'solver@test.local');

-- handle_new_user created profiles (role citizen). Promote the solver + give it
-- a public solver profile (so attribution joins resolve to a handle/type).
update public.profiles set role = 'solver' where id = '55555555-5555-5555-5555-555555555555';
insert into public.solver_profiles (id, handle, type)
  values ('55555555-5555-5555-5555-555555555555', 'alcaldia-cali', 'government');

-- R1: nuevo with a citizen reporter.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', c.id, 'nuevo',
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

-- R2: nuevo with NO reporter (anonymous-majority reality, SCEN-005).
insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'a2222222-2222-2222-2222-222222222222', null, c.id, 'nuevo',
       'SRID=4326;POINT(-74.08 4.62)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

-- R3: nuevo; a processed kind='report' media makes the trigger publish it.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'a3333333-3333-3333-3333-333333333333', null, c.id, 'nuevo',
       'SRID=4326;POINT(-74.08 4.63)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

insert into public.report_media (report_id, storage_path, type, processing_state, kind)
  values ('a3333333-3333-3333-3333-333333333333', 'a333/report.jpg', 'image', 'processed', 'report');

-- ===========================================================================
-- SCEN-001 (claim): solver claims R1 (nuevo → en_proceso). RPC under the role;
-- assertions after reset role (superuser bypasses RLS on the non-visible report).
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select count(*) from public.change_report_status('a1111111-1111-1111-1111-111111111111', 'en_proceso', null);
reset role;

select is(
  (select status from public.reports where id = 'a1111111-1111-1111-1111-111111111111'),
  'en_proceso'::public.report_status,
  'SCEN-001: solver claim sets reports.status = en_proceso');

select is(
  (select claimed_by from public.reports where id = 'a1111111-1111-1111-1111-111111111111'),
  '55555555-5555-5555-5555-555555555555'::uuid,
  'SCEN-001: claimed_by equals the solver auth.uid() (no client-supplied attribution)');

select isnt(
  (select claimed_at from public.reports where id = 'a1111111-1111-1111-1111-111111111111'),
  null::timestamptz,
  'SCEN-001: claimed_at is stamped on claim');

-- ===========================================================================
-- SCEN-003 (proof required): resolve R1 with NO processed resolution media yet
-- → raises P0001 and the status is unchanged. Asserted BEFORE any processed
-- proof exists so the gate genuinely fires.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.change_report_status('a1111111-1111-1111-1111-111111111111', 'resuelto', null) $$,
  'P0001',
  'resolution proof required',
  'SCEN-003: resolving without processed resolution proof raises P0001');
reset role;

select is(
  (select status from public.reports where id = 'a1111111-1111-1111-1111-111111111111'),
  'en_proceso'::public.report_status,
  'SCEN-003: the report status is unchanged (still en_proceso) after the refused resolve');

-- ===========================================================================
-- Visibility-trigger v2 regression (blocker #1): R3 is visible via a processed
-- kind='report' media; attaching a PENDING kind='resolution' proof must NOT
-- un-publish it. Independent report so it never couples with SCEN-003's gate.
-- All reads as superuser (no role switch needed — no authz involved).
-- ===========================================================================
select is(
  (select is_visible from public.reports where id = 'a3333333-3333-3333-3333-333333333333'),
  true,
  'trigger v2: R3 is visible (its only report media is processed)');

insert into public.report_media (report_id, storage_path, type, processing_state, kind)
  values ('a3333333-3333-3333-3333-333333333333', 'a333/proof.jpg', 'image', 'pending', 'resolution');

select is(
  (select is_visible from public.reports where id = 'a3333333-3333-3333-3333-333333333333'),
  true,
  'trigger v2: a PENDING resolution proof does NOT un-publish the visible report');

-- ===========================================================================
-- SCEN-002 (resolve with proof): attach a PROCESSED resolution proof to R1,
-- then solver resolves it → resuelto, resolved_by = solver, resolved_at set,
-- exactly one history row to_status='resuelto'.
-- ===========================================================================
insert into public.report_media (report_id, storage_path, type, processing_state, kind)
  values ('a1111111-1111-1111-1111-111111111111', 'a111/proof.jpg', 'image', 'processed', 'resolution');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select count(*) from public.change_report_status('a1111111-1111-1111-1111-111111111111', 'resuelto', null);
reset role;

select is(
  (select status from public.reports where id = 'a1111111-1111-1111-1111-111111111111'),
  'resuelto'::public.report_status,
  'SCEN-002: solver resolve sets reports.status = resuelto');

select is(
  (select resolved_by from public.reports where id = 'a1111111-1111-1111-1111-111111111111'),
  '55555555-5555-5555-5555-555555555555'::uuid,
  'SCEN-002/006: resolved_by equals the solver auth.uid() (no forgery)');

select isnt(
  (select resolved_at from public.reports where id = 'a1111111-1111-1111-1111-111111111111'),
  null::timestamptz,
  'SCEN-002: resolved_at is stamped on resolve');

select is(
  (select count(*) from public.report_status_history
   where report_id = 'a1111111-1111-1111-1111-111111111111'
     and to_status = 'resuelto')::int,
  1,
  'SCEN-002: exactly one audit row records the resolved transition');

-- ===========================================================================
-- SCEN-004 (authz): a citizen cannot claim or resolve; a solver cannot
-- descartar. Each is refused (42501) and nothing changes. R2 is the subject
-- (still nuevo, untouched). Staff retaining all powers is covered by
-- change_report_status_test.sql.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ select public.change_report_status('a2222222-2222-2222-2222-222222222222', 'en_proceso', null) $$,
  '42501',
  'forbidden',
  'SCEN-004: a citizen claiming a report raises forbidden (42501)');

select throws_ok(
  $$ select public.change_report_status('a2222222-2222-2222-2222-222222222222', 'resuelto', null) $$,
  '42501',
  'forbidden',
  'SCEN-004: a citizen resolving a report raises forbidden (42501)');
reset role;

-- A solver may NOT move a report to descartado (staff/admin-only).
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ select public.change_report_status('a2222222-2222-2222-2222-222222222222', 'descartado', null) $$,
  '42501',
  'forbidden',
  'SCEN-004: a solver moving a report to descartado raises forbidden (42501)');
reset role;

select is(
  (select status from public.reports where id = 'a2222222-2222-2222-2222-222222222222'),
  'nuevo'::public.report_status,
  'SCEN-004: R2 status is unchanged (still nuevo) after every refused call');

-- ===========================================================================
-- SCEN-005 (anonymous report resolvable): R2 has reporter_id NULL. A solver
-- claims it, attaches processed proof, and resolves it — no dependency on the
-- (absent) reporter.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select count(*) from public.change_report_status('a2222222-2222-2222-2222-222222222222', 'en_proceso', null);
reset role;

insert into public.report_media (report_id, storage_path, type, processing_state, kind)
  values ('a2222222-2222-2222-2222-222222222222', 'a222/proof.jpg', 'image', 'processed', 'resolution');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
select count(*) from public.change_report_status('a2222222-2222-2222-2222-222222222222', 'resuelto', null);
reset role;

select is(
  (select status from public.reports where id = 'a2222222-2222-2222-2222-222222222222'),
  'resuelto'::public.report_status,
  'SCEN-005: a null-reporter report is resolvable (status = resuelto)');

select is(
  (select resolved_by from public.reports where id = 'a2222222-2222-2222-2222-222222222222'),
  '55555555-5555-5555-5555-555555555555'::uuid,
  'SCEN-005: resolved_by is the solver even with no original reporter');

-- ===========================================================================
-- SCEN-006 (no self-attribution forgery): resolved_by == auth.uid() is asserted
-- above; here we prove the RPC carries NO attribution param — its IN argument
-- names are exactly {p_report_id, p_to_status, p_note} (mode 'i'), so a client
-- can never pass an attribution id.
-- ===========================================================================
select set_eq(
  $$ select a.name
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
     where n.nspname = 'public'
       and p.proname = 'change_report_status'
       and a.mode = 'i' $$,
  $$ values ('p_report_id'), ('p_to_status'), ('p_note') $$,
  'SCEN-006: change_report_status IN args are exactly {p_report_id, p_to_status, p_note} (no attribution param)'
);

select * from finish();
rollback;
