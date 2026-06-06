-- change_report_status RPC tests (pgTAP). Run with: supabase test db
--
-- Arbiter for the AUDITED status-change write path (step13,
-- panel-status-change.scenarios.md + panel-status-change-hardening.scenarios.md).
-- Covers:
--   SCEN-003/E4  staff change applied + audited (status, one history row,
--                from/to/changed_by/note correct)
--   SCEN-004/E7  ->resuelto stamps resolved_at; a non-resuelto transition leaves
--                resolved_at null
--   SCEN-006     unknown report id raises (route maps to 404)
--   SCEN-007/E3  a non-staff (citizen) caller is refused AND the status is
--                unchanged — the DB is the security boundary, not just the route
--   SCEN-008     atomicity: the new status and its single matching history row
--                coexist, with from_status = the pre-change status
--   SCEN-H01     a no-op (same status) is inert: no junk audit row, no
--                resolved_at drift; the call still succeeds
--   SCEN-H02     a genuine change after a no-op still audits with the correct
--                from_status (the no-op did not corrupt the pre-state)
--
-- Identity is switched with `set local role authenticated` +
-- `request.jwt.claims` (sub) exactly like rls_test.sql; the function runs
-- SECURITY DEFINER but its internal `private.is_staff()` gate reads
-- `auth.uid()` from those claims.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(17);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'citizen@test.local'),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'staff@test.local');

-- handle_new_user created profiles (role citizen). Promote the second to staff.
update public.profiles set role = 'staff' where id = '33333333-3333-3333-3333-333333333333';

-- One report in status `nuevo` to transition.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', c.id, 'nuevo',
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

-- ---------------------------------------------------------------------------
-- SCEN-007 (E3, DB boundary): a CITIZEN calling the RPC directly is refused,
-- and the report status is unchanged. Run this FIRST so the report is still
-- `nuevo` for the staff happy-path below.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ select public.change_report_status('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'en_proceso', 'intento') $$,
  '42501',
  'forbidden',
  'SCEN-007: a citizen calling change_report_status directly raises forbidden (42501)');
reset role;

select is(
  (select status from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'nuevo'::public.report_status,
  'SCEN-007: the report status is unchanged after the refused citizen call');

select is(
  (select count(*) from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::int,
  0,
  'SCEN-007: no history row was written for the refused citizen call');

-- ---------------------------------------------------------------------------
-- SCEN-003 (E4): a STAFF change nuevo -> en_proceso is applied AND audited.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);

-- Invoke the RPC (discard the returned row); a raise here would fail the test run.
select count(*) from public.change_report_status('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'en_proceso', 'una nota');

select is(
  (select status from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'en_proceso'::public.report_status,
  'SCEN-003: staff change sets reports.status = en_proceso');

-- SCEN-008 (atomicity): exactly one matching history row coexists with the
-- new status, carrying from_status = the pre-change status (nuevo).
select is(
  (select count(*) from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::int,
  1,
  'SCEN-008: exactly one history row exists after the change (status + audit coexist)');

select is(
  (select from_status from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'nuevo'::public.report_status,
  'SCEN-003/008: history.from_status equals the pre-change status (nuevo)');

select is(
  (select to_status from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'en_proceso'::public.report_status,
  'SCEN-003: history.to_status equals the new status (en_proceso)');

select is(
  (select changed_by from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'SCEN-003: history.changed_by equals the staff user id');

select is(
  (select note from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'una nota',
  'SCEN-003: history.note equals the supplied note');

-- SCEN-004 (E7, negative path): a transition to a non-resuelto status leaves
-- resolved_at null.
select is(
  (select resolved_at from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  null::timestamptz,
  'SCEN-004: a non-resuelto transition leaves resolved_at null');

-- ---------------------------------------------------------------------------
-- SCEN-004 (E7): STAFF en_proceso -> resuelto stamps resolved_at.
-- ---------------------------------------------------------------------------
select count(*) from public.change_report_status('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'resuelto', null);

select isnt(
  (select resolved_at from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  null::timestamptz,
  'SCEN-004: moving to resuelto stamps resolved_at (non-null)');

-- ---------------------------------------------------------------------------
-- SCEN-H01: a no-op (same status) is inert — no junk audit row, no resolved_at
-- drift. The report is currently `resuelto` with a stamped resolved_at (above).
-- Snapshot the resolved_at + the history-row count, then call with the SAME
-- status and assert nothing moved.
-- ---------------------------------------------------------------------------
create temp table _snap as
select
  (select resolved_at from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') as resolved_at,
  (select count(*) from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::int as history_count;

select lives_ok(
  $$ select public.change_report_status('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'resuelto', null) $$,
  'SCEN-H01: a no-op same-status call does not raise');

select is(
  (select count(*) from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::int,
  (select history_count from _snap),
  'SCEN-H01: a no-op writes NO new history row (count unchanged)');

select is(
  (select resolved_at from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (select resolved_at from _snap),
  'SCEN-H01: a no-op does NOT re-stamp resolved_at (preserved)');

-- ---------------------------------------------------------------------------
-- SCEN-H02: a genuine change after the no-op still audits correctly — exactly
-- one new history row with the true from_status (`resuelto`), proving the no-op
-- guard did not corrupt the captured pre-state.
-- ---------------------------------------------------------------------------
select count(*) from public.change_report_status('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'en_proceso', null);

select is(
  (select count(*) from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::int,
  (select history_count + 1 from _snap),
  'SCEN-H02: a genuine change after a no-op writes exactly one new history row');

-- The H02 row is uniquely the resuelto -> en_proceso transition (rows share
-- created_at within the test transaction, so we identify it by from/to, not by
-- ordering). Exactly one such row proves the no-op left the pre-state intact.
select is(
  (select count(*) from public.report_status_history
   where report_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     and from_status = 'resuelto'
     and to_status = 'en_proceso')::int,
  1,
  'SCEN-H02: the genuine change records from_status = the unchanged current status (resuelto)');

-- ---------------------------------------------------------------------------
-- SCEN-006: an unknown report id raises (route maps to 404).
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.change_report_status('00000000-0000-0000-0000-000000000000', 'en_proceso', null) $$,
  'P0002',
  'report not found',
  'SCEN-006: an unknown report id raises not-found (P0002)');

reset role;

select * from finish();
rollback;
