-- solver_reputation tests (pgTAP). Run with: supabase test db
--
-- Arbiter for the DB half of subsystem C, chunk C1 (solver-reputation.scenarios.md
-- SCEN-001..005, 009, 010). Reputation is denormalized counts on solver_profiles,
-- maintained by recompute triggers, plus a BEFORE INSERT stamp that captures the
-- challenged solver on each dispute. Covers:
--   SCEN-001  stamp: a dispute filed against a resuelto report (resolved_by = S),
--             with a FORGED disputed_solver_id payload, stores disputed_solver_id = S
--             (the trigger overwrites the client value unconditionally).
--   SCEN-002  resolve: making a visible report resuelto with resolved_by = S raises
--             S.resolved_count by 1 (read from the column).
--   SCEN-003  uphold: upholding a dispute against S raises S.upheld_count by 1 and
--             leaves S.resolved_count unchanged (the report stays resuelto).
--   SCEN-004  revert: reverting a dispute against S (via the real resolve_dispute
--             RPC as admin) raises S.reverted_count by 1 and drops S.resolved_count
--             by 1 (the report leaves resuelto).
--   SCEN-005  staff-resolved: a report resolved by a STAFF profile (no solver_profiles
--             row), disputed + reverted, changes no solver_profiles row's counts.
--   SCEN-009  ordering: order by reverted_count DESC returns the higher one first
--             (primary sort only; the reliability tiebreak is a JS post-fetch concern).
--   SCEN-010  RLS: anon SELECT on solver_profiles returns the counts (>=0 rows);
--             anon SELECT on report_disputes returns 0 rows (admin-only).
--   grants    the three trigger fns are NOT executable by anon/authenticated.
--
-- Counts are asserted by READING the columns from solver_profiles (never recomputed
-- in the test — the B3.3 false-green lesson). Fixtures are ISOLATED (built here) so
-- this passes on a fresh `supabase db reset` alongside the other files. Identity is
-- switched with `set local role authenticated` + request.jwt.claims exactly like
-- report_disputes_test.sql; state assertions `reset role` first so they read as
-- superuser (bypassing RLS), except the explicit RLS tests which assert UNDER anon.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(16);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS).
--   S1  — verified solver (has a solver_profiles row). The reputation subject.
--   S2  — a 2nd verified solver, used only for the SCEN-009 ordering pair and as
--         the FORGED value in SCEN-001.
--   STAFF — a staff profile WITHOUT a solver_profiles row (SCEN-005).
--   ADMIN — reviews disputes via resolve_dispute.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'rep-admin@test.local'),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000051', 'authenticated', 'authenticated', 'rep-solver1@test.local'),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000052', 'authenticated', 'authenticated', 'rep-solver2@test.local'),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000031', 'authenticated', 'authenticated', 'rep-staff@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'rep-citizen@test.local');

update public.profiles set role = 'admin'  where id = 'a0000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'solver' where id = '50000000-0000-0000-0000-000000000051';
update public.profiles set role = 'solver' where id = '50000000-0000-0000-0000-000000000052';
update public.profiles set role = 'staff'  where id = '30000000-0000-0000-0000-000000000031';

-- Public solver profiles for S1 + S2 (STAFF deliberately has none -> SCEN-005).
insert into public.solver_profiles (id, handle, type) values
  ('50000000-0000-0000-0000-000000000051', 'solver-one', 'org'),
  ('50000000-0000-0000-0000-000000000052', 'solver-two', 'org');

-- ---------------------------------------------------------------------------
-- SCEN-002 (resolve increments resolved_count): make a VISIBLE report resuelto
-- with resolved_by = S1. The recount_from_reports trigger fires on the INSERT.
-- R1 is the working report for SCEN-001/003 (resolved by S1, stays resuelto).
-- ---------------------------------------------------------------------------
insert into public.reports (id, reporter_id, category_id, status, location, is_visible, claimed_by, claimed_at, resolved_by, resolved_at)
select '11111111-0000-0000-0000-000000000001'::uuid, null, c.id, 'resuelto'::public.report_status,
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true,
       '50000000-0000-0000-0000-000000000051'::uuid, now(),
       '50000000-0000-0000-0000-000000000051'::uuid, now()
from public.categories c where c.slug = 'bache';

select is(
  (select resolved_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  1,
  'SCEN-002: resolving a visible report (resolved_by = S1) raises S1.resolved_count to 1');

-- A resolved-but-INVISIBLE report must NOT inflate resolved_count (it would not
-- appear on the profile wall). Insert one, confirm the count stays at 1.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible, resolved_by, resolved_at)
select '1a111111-0000-0000-0000-00000000001a'::uuid, null, c.id, 'resuelto'::public.report_status,
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, false,
       '50000000-0000-0000-0000-000000000051'::uuid, now()
from public.categories c where c.slug = 'bache';

select is(
  (select resolved_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  1,
  'SCEN-002: a resuelto-but-invisible report does NOT inflate resolved_count (still 1)');

-- ---------------------------------------------------------------------------
-- SCEN-001 (stamp the challenged solver, overwrite the forged value): file a
-- dispute against R1 (resolved_by = S1) while FORGING disputed_solver_id = S2. The
-- BEFORE INSERT trigger must overwrite it with S1.
-- ---------------------------------------------------------------------------
insert into public.report_disputes (id, report_id, status, disputed_solver_id)
values ('d1111111-0000-0000-0000-000000000001',
        '11111111-0000-0000-0000-000000000001', 'open',
        '50000000-0000-0000-0000-000000000052');  -- FORGED: S2, not S1

select is(
  (select disputed_solver_id from public.report_disputes where id = 'd1111111-0000-0000-0000-000000000001'),
  '50000000-0000-0000-0000-000000000051'::uuid,
  'SCEN-001: the stamp trigger overwrites the forged disputed_solver_id with the report''s resolved_by (S1)');

-- ---------------------------------------------------------------------------
-- SCEN-003 (uphold keeps resolved, increments upheld): an admin upholds the dispute
-- on R1 via the real resolve_dispute RPC. upheld_count +1, resolved_count unchanged.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select count(*) from public.resolve_dispute('d1111111-0000-0000-0000-000000000001', 'uphold');
reset role;

select is(
  (select upheld_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  1,
  'SCEN-003: upholding a dispute against S1 raises S1.upheld_count to 1');

select is(
  (select resolved_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  1,
  'SCEN-003: upholding leaves S1.resolved_count unchanged (the report stays resuelto)');

-- ---------------------------------------------------------------------------
-- SCEN-004 (revert decrements resolved, increments reverted): R2 is another visible
-- resuelto report by S1 (now resolved_count = 2). An admin reverts a dispute on it
-- via the real resolve_dispute RPC -> the report leaves resuelto (resolved_by
-- nulled). reverted_count +1, resolved_count -1 (back to 1).
-- ---------------------------------------------------------------------------
insert into public.reports (id, reporter_id, category_id, status, location, is_visible, claimed_by, claimed_at, resolved_by, resolved_at)
select '22222222-0000-0000-0000-000000000002'::uuid, null, c.id, 'resuelto'::public.report_status,
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true,
       '50000000-0000-0000-0000-000000000051'::uuid, now(),
       '50000000-0000-0000-0000-000000000051'::uuid, now()
from public.categories c where c.slug = 'bache';

select is(
  (select resolved_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  2,
  'SCEN-004 (setup): a 2nd visible resuelto report raises S1.resolved_count to 2');

insert into public.report_disputes (id, report_id, status)
values ('d2222222-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'open');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select count(*) from public.resolve_dispute('d2222222-0000-0000-0000-000000000002', 'revert');
reset role;

select is(
  (select reverted_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  1,
  'SCEN-004: reverting a dispute against S1 raises S1.reverted_count to 1');

select is(
  (select resolved_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  1,
  'SCEN-004: reverting drops S1.resolved_count back to 1 (the report left resuelto)');

-- ---------------------------------------------------------------------------
-- SCEN-005 (staff-resolved earns no solver reputation): a visible resuelto report
-- resolved by STAFF (no solver_profiles row), disputed + reverted. No
-- solver_profiles row's counts change. Capture every count before/after.
-- ---------------------------------------------------------------------------
insert into public.reports (id, reporter_id, category_id, status, location, is_visible, claimed_by, claimed_at, resolved_by, resolved_at)
select '33333333-0000-0000-0000-000000000003'::uuid, null, c.id, 'resuelto'::public.report_status,
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true,
       '30000000-0000-0000-0000-000000000031'::uuid, now(),
       '30000000-0000-0000-0000-000000000031'::uuid, now()
from public.categories c where c.slug = 'bache';

-- Snapshot of all solver counts before the staff dispute resolution.
create temporary table rep_snapshot on commit drop as
  select id, resolved_count, upheld_count, reverted_count
  from public.solver_profiles;

insert into public.report_disputes (id, report_id, status)
values ('d3333333-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000003', 'open');

-- The staff resolution has no solver_profiles row, so the stamp matches nobody.
select is(
  (select disputed_solver_id from public.report_disputes where id = 'd3333333-0000-0000-0000-000000000003'),
  '30000000-0000-0000-0000-000000000031'::uuid,
  'SCEN-005: the stamp records the staff resolver id (which has no solver_profiles row)');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select count(*) from public.resolve_dispute('d3333333-0000-0000-0000-000000000003', 'revert');
reset role;

select is(
  (select count(*)::int from public.solver_profiles sp
   join rep_snapshot s on s.id = sp.id
   where sp.resolved_count is distinct from s.resolved_count
      or sp.upheld_count   is distinct from s.upheld_count
      or sp.reverted_count is distinct from s.reverted_count),
  0,
  'SCEN-005: a staff-resolved report disputed+reverted changes NO solver_profiles row''s counts');

-- ---------------------------------------------------------------------------
-- SCEN-009 (admin signal ordering, primary sort only): give S2 a higher
-- reverted_count than S1, then order by reverted_count DESC and confirm S2 first.
-- (The reliability tiebreak is NOT a DB concern.) S1 has reverted_count = 1; give
-- S2 reverted_count = 2 via two reverted disputes on two of S2's resolutions.
-- ---------------------------------------------------------------------------
insert into public.reports (id, reporter_id, category_id, status, location, is_visible, claimed_by, claimed_at, resolved_by, resolved_at)
select x.id, null, c.id, 'resuelto'::public.report_status,
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true,
       '50000000-0000-0000-0000-000000000052'::uuid, now(),
       '50000000-0000-0000-0000-000000000052'::uuid, now()
from (values
  ('99999999-0000-0000-0000-000000000091'::uuid),
  ('99999999-0000-0000-0000-000000000092'::uuid)
) as x(id)
cross join lateral (select id from public.categories where slug = 'bache') c;

insert into public.report_disputes (id, report_id, status) values
  ('d9999999-0000-0000-0000-000000000091', '99999999-0000-0000-0000-000000000091', 'open'),
  ('d9999999-0000-0000-0000-000000000092', '99999999-0000-0000-0000-000000000092', 'open');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select count(*) from public.resolve_dispute('d9999999-0000-0000-0000-000000000091', 'revert');
select count(*) from public.resolve_dispute('d9999999-0000-0000-0000-000000000092', 'revert');
reset role;

select is(
  (select reverted_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000052')::int,
  2,
  'SCEN-009 (setup): S2 has reverted_count = 2 (> S1''s 1)');

select is(
  (select id from public.solver_profiles
   where id in ('50000000-0000-0000-0000-000000000051', '50000000-0000-0000-0000-000000000052')
   order by reverted_count desc, id
   limit 1),
  '50000000-0000-0000-0000-000000000052'::uuid,
  'SCEN-009: order by reverted_count DESC returns the higher-reverted solver (S2) first');

-- ---------------------------------------------------------------------------
-- Guard (edge-case review): a no-op UPDATE on report_disputes that does NOT change
-- status must leave the counts untouched — proves recount_from_disputes
-- short-circuits on `old.status is distinct from new.status` = false (the FALSE
-- branch the scenario flows never otherwise exercise). d1111111 is `upheld`
-- (S1.upheld_count = 1); touching only `reason` must keep it at 1.
-- ---------------------------------------------------------------------------
update public.report_disputes
   set reason = coalesce(reason, '') || ''
 where id = 'd1111111-0000-0000-0000-000000000001';

select is(
  (select upheld_count from public.solver_profiles where id = '50000000-0000-0000-0000-000000000051')::int,
  1,
  'guard: a no-op UPDATE (status unchanged) on a dispute does not change upheld_count');

-- ---------------------------------------------------------------------------
-- SCEN-010 (counts are public, disputers are not): as anon, solver_profiles counts
-- are readable (public reputation) but report_disputes returns 0 rows (admin-only).
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

select ok(
  (select count(*) from public.solver_profiles)::int >= 2,
  'SCEN-010: an anonymous client CAN read solver_profiles (public reputation counts)');

select is(
  (select count(*) from public.report_disputes)::int,
  0,
  'SCEN-010: an anonymous client sees 0 report_disputes rows (who disputed stays admin-only)');
reset role;

-- ---------------------------------------------------------------------------
-- Grants probe: the three trigger fns are trigger-only — NOT executable by anon or
-- authenticated (they do not enter the advisor 0028/0029 baseline).
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.report_disputes_stamp_solver()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.report_disputes_stamp_solver()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.solver_reputation_recount_from_reports()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.solver_reputation_recount_from_reports()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.solver_reputation_recount_from_disputes()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.solver_reputation_recount_from_disputes()', 'EXECUTE'),
  'grant: anon + authenticated CANNOT EXECUTE the three reputation trigger functions');

select * from finish();
rollback;
