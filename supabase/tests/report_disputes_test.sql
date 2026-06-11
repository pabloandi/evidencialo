-- report_disputes + resolve_dispute tests (pgTAP). Run with: supabase test db
--
-- Arbiter for the dispute path (subsystem B, chunk B3.1 —
-- solver-resolution.scenarios.md SCEN-007). Covers:
--   SCEN-007     a filed dispute, REVERTED by an admin, returns the report to
--                `en_proceso`, clears resolved_at/resolved_by (NULL), leaves
--                claimed_by intact, closes the dispute (reverted + reviewer), and
--                writes an audit row.
--   uphold       an UPHELD dispute leaves the report `resuelto`; dispute closes.
--   coalesce     at most ONE open dispute per report (partial unique index -> 23505).
--   authz        a citizen / solver / staff (non-admin) calling resolve_dispute is
--                refused (42501) and nothing changes — the DB is the boundary.
--   RLS insert   a client may file only an `open` dispute, only on a `resuelto`
--                report; `upheld` and non-resuelto targets are rejected.
--   RLS read     dispute rows are admin-only.
--   grants       authenticated may EXECUTE resolve_dispute; anon may NOT.
--
-- Identity is switched with `set local role authenticated` + request.jwt.claims
-- exactly like change_report_status_test.sql; the RPC runs SECURITY DEFINER but
-- its internal private.is_admin() gate reads auth.uid() from those claims. State
-- assertions `reset role` first so they read as superuser (bypassing RLS),
-- except the explicit RLS-read test which asserts UNDER each role.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(23);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'admin@test.local'),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000051', 'authenticated', 'authenticated', 'solver@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'citizen@test.local'),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000031', 'authenticated', 'authenticated', 'staff@test.local');

-- handle_new_user created profiles (role citizen). Promote three of them.
update public.profiles set role = 'admin'  where id = 'a0000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'solver' where id = '50000000-0000-0000-0000-000000000051';
update public.profiles set role = 'staff'  where id = '30000000-0000-0000-0000-000000000031';

-- Resolved reports (R1, R2, R4) attributed to the solver, plus a `nuevo` report
-- (R3) to prove a non-resuelto target is undisputable. All visible so the RLS
-- insert WITH CHECK subquery (reports_select_public) can see them.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible, claimed_by, claimed_at, resolved_by, resolved_at)
select x.id, null, c.id, x.status, 'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true,
       x.claimed_by, x.claimed_at, x.resolved_by, x.resolved_at
from (values
  ('11111111-0000-0000-0000-000000000001'::uuid, 'resuelto'::public.report_status, '50000000-0000-0000-0000-000000000051'::uuid, now(), '50000000-0000-0000-0000-000000000051'::uuid, now()),
  ('22222222-0000-0000-0000-000000000002'::uuid, 'resuelto'::public.report_status, '50000000-0000-0000-0000-000000000051'::uuid, now(), '50000000-0000-0000-0000-000000000051'::uuid, now()),
  ('44444444-0000-0000-0000-000000000004'::uuid, 'resuelto'::public.report_status, '50000000-0000-0000-0000-000000000051'::uuid, now(), '50000000-0000-0000-0000-000000000051'::uuid, now()),
  ('33333333-0000-0000-0000-000000000003'::uuid, 'nuevo'::public.report_status, null::uuid, null::timestamptz, null::uuid, null::timestamptz)
) as x(id, status, claimed_by, claimed_at, resolved_by, resolved_at)
cross join lateral (select id from public.categories where slug = 'bache') c;

-- ---------------------------------------------------------------------------
-- SCEN-007 (revert): an admin reverts a dispute on R1.
-- ---------------------------------------------------------------------------
insert into public.report_disputes (id, report_id, reason, status)
values ('d1111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'no está arreglado', 'open');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

select lives_ok(
  $$ select public.resolve_dispute('d1111111-0000-0000-0000-000000000001', 'revert') $$,
  'SCEN-007: an admin can revert an open dispute');
reset role;

select is(
  (select status from public.reports where id = '11111111-0000-0000-0000-000000000001'),
  'en_proceso'::public.report_status,
  'SCEN-007: revert returns the report to en_proceso');

select is(
  (select resolved_at from public.reports where id = '11111111-0000-0000-0000-000000000001'),
  null::timestamptz,
  'SCEN-007: revert clears resolved_at (NULL)');

select is(
  (select resolved_by from public.reports where id = '11111111-0000-0000-0000-000000000001'),
  null::uuid,
  'SCEN-007: revert clears resolved_by (NULL) — attribution stripped');

select is(
  (select claimed_by from public.reports where id = '11111111-0000-0000-0000-000000000001'),
  '50000000-0000-0000-0000-000000000051'::uuid,
  'SCEN-007: revert PRESERVES claimed_by (only resolved_* are cleared)');

select is(
  (select status from public.report_disputes where id = 'd1111111-0000-0000-0000-000000000001'),
  'reverted',
  'SCEN-007: the dispute is marked reverted');

select is(
  (select reviewed_by from public.report_disputes where id = 'd1111111-0000-0000-0000-000000000001'),
  'a0000000-0000-0000-0000-0000000000a1'::uuid,
  'SCEN-007: the dispute records the admin reviewer');

select is(
  (select count(*) from public.report_status_history
   where report_id = '11111111-0000-0000-0000-000000000001'
     and to_status = 'en_proceso')::int,
  1,
  'SCEN-007: the revert writes exactly one audit row (to_status = en_proceso)');

-- ---------------------------------------------------------------------------
-- uphold: an admin upholds a dispute on R2 — the report stays resuelto.
-- ---------------------------------------------------------------------------
insert into public.report_disputes (id, report_id, status)
values ('d2222222-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'open');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select count(*) from public.resolve_dispute('d2222222-0000-0000-0000-000000000002', 'uphold');
reset role;

select is(
  (select status from public.reports where id = '22222222-0000-0000-0000-000000000002'),
  'resuelto'::public.report_status,
  'uphold: the report stays resuelto');

select is(
  (select status from public.report_disputes where id = 'd2222222-0000-0000-0000-000000000002'),
  'upheld',
  'uphold: the dispute is marked upheld');

-- ---------------------------------------------------------------------------
-- coalesce: at most one OPEN dispute per report (partial unique index).
-- ---------------------------------------------------------------------------
insert into public.report_disputes (id, report_id, status)
values ('d4444444-0000-0000-0000-000000000004', '44444444-0000-0000-0000-000000000004', 'open');

select throws_ok(
  $$ insert into public.report_disputes (report_id, status)
     values ('44444444-0000-0000-0000-000000000004', 'open') $$,
  '23505',
  null,
  'coalesce: a second OPEN dispute on the same report violates the partial unique index (23505)');

-- ---------------------------------------------------------------------------
-- authz: a non-admin calling resolve_dispute is refused (42501). Target the
-- still-open dispute on R4.
-- ---------------------------------------------------------------------------
set local role authenticated;

select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.resolve_dispute('d4444444-0000-0000-0000-000000000004', 'revert') $$,
  '42501', 'forbidden',
  'authz: a citizen calling resolve_dispute is refused (42501)');

select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000051', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.resolve_dispute('d4444444-0000-0000-0000-000000000004', 'revert') $$,
  '42501', 'forbidden',
  'authz: a solver calling resolve_dispute is refused (42501)');

select set_config('request.jwt.claims',
  json_build_object('sub', '30000000-0000-0000-0000-000000000031', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.resolve_dispute('d4444444-0000-0000-0000-000000000004', 'revert') $$,
  '42501', 'forbidden',
  'authz: a staff (non-admin) calling resolve_dispute is refused (42501)');
reset role;

select is(
  (select status from public.report_disputes where id = 'd4444444-0000-0000-0000-000000000004'),
  'open',
  'authz: the dispute is unchanged after the refused calls (still open)');

select is(
  (select status from public.reports where id = '44444444-0000-0000-0000-000000000004'),
  'resuelto'::public.report_status,
  'authz: the report is unchanged after the refused calls (still resuelto)');

-- ---------------------------------------------------------------------------
-- RLS insert WITH CHECK (as an authenticated citizen).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ insert into public.report_disputes (report_id, status, created_by)
     values ('22222222-0000-0000-0000-000000000002', 'upheld', 'c0000000-0000-0000-0000-0000000000c1') $$,
  '42501', null,
  'RLS: a client cannot forge a non-open (upheld) dispute');

select throws_ok(
  $$ insert into public.report_disputes (report_id, status, created_by)
     values ('33333333-0000-0000-0000-000000000003', 'open', 'c0000000-0000-0000-0000-0000000000c1') $$,
  '42501', null,
  'RLS: a client cannot dispute a non-resuelto report');

select lives_ok(
  $$ insert into public.report_disputes (report_id, status, created_by)
     values ('22222222-0000-0000-0000-000000000002', 'open', 'c0000000-0000-0000-0000-0000000000c1') $$,
  'RLS: a client CAN file an open dispute on a resuelto report');
reset role;

-- ---------------------------------------------------------------------------
-- RLS read: dispute rows are admin-only.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select is(
  (select count(*) from public.report_disputes)::int,
  0,
  'RLS read: a non-admin (citizen) sees no dispute rows');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select ok(
  (select count(*) from public.report_disputes)::int > 0,
  'RLS read: an admin sees dispute rows');
reset role;

-- ---------------------------------------------------------------------------
-- Grants: authenticated may EXECUTE; anon may NOT (Supabase default-EXECUTE-to-
-- anon trap — anon is revoked by name in 0017).
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'public.resolve_dispute(uuid, text)', 'EXECUTE'),
  'grant: authenticated can EXECUTE resolve_dispute');

select ok(
  not has_function_privilege('anon', 'public.resolve_dispute(uuid, text)', 'EXECUTE'),
  'grant: anon CANNOT EXECUTE resolve_dispute');

select * from finish();
rollback;
