-- report_validations + validate_report tests (pgTAP). Run with: supabase test db
--
-- Arbiter for the citizen-validation / corroboration path (subsystem A, chunk A1 —
-- citizen-validation.scenarios.md SCEN-001..008, 010). Covers:
--   SCEN-006  author-seed: an AUTHORED report lands at verified_count = 1
--             immediately (the seed row exists; the authored INSERT completes and
--             returns — locking the recount/seed cycle-termination invariant); an
--             ANONYMOUS report (no reporter_id) starts at verified_count = 0.
--   SCEN-001  a 2nd distinct authenticated user calling validate_report -> a row
--             exists for them and verified_count = 2.
--   SCEN-003  an anonymous validate (ip_hash) -> anon_count rises, verified_count
--             unchanged, and priority_score (READ from the column) equals
--             verified_count + anon_count / 4.
--   SCEN-004  a repeat identical call adds 0 rows, leaves counts unchanged, and
--             reports newly_added = false.
--   SCEN-005  validate_report against a resuelto / hidden report raises P0001 and
--             inserts nothing.
--   SCEN-008  RLS: select-own returns only the caller's rows; anon (role) sees 0
--             rows; a direct client INSERT is refused (42501, no insert policy);
--             an admin sees all.
--   SCEN-010  two reports order correctly by priority_score DESC (read from column).
--   misc      empty ip_hash -> 22023; grants probe (anon may EXECUTE
--             validate_report; anon may NOT EXECUTE the recount trigger function).
--
-- Fixtures are ISOLATED (no dependence on seed reports) so this passes on a fresh
-- `supabase db reset` alongside the other test files. Identity is switched with
-- `set local role authenticated` + request.jwt.claims (validate_report runs
-- SECURITY DEFINER but reads auth.uid() from those claims). State assertions
-- `reset role` first so they read as superuser (bypassing RLS), except the
-- explicit RLS tests which assert UNDER each role.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(24);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'val-admin@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', 'val-author@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'val-citizen2@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-0000000000d1', 'authenticated', 'authenticated', 'val-citizen3@test.local');

update public.profiles set role = 'admin' where id = 'a0000000-0000-0000-0000-0000000000a1';

-- R1: AUTHORED + visible + nuevo. The author-seed trigger fires on INSERT, so
-- this is the SCEN-006 authored case. lives_ok proves the INSERT completes (the
-- seed -> recount -> update reports chain terminates, no infinite trigger loop).
select lives_ok(
  $$ insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
     select '11111111-0000-0000-0000-000000000001'::uuid,
            'b0000000-0000-0000-0000-0000000000b1'::uuid,
            c.id, 'nuevo'::public.report_status,
            'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true
     from public.categories c where c.slug = 'bache' $$,
  'SCEN-006: an AUTHORED report INSERT completes (seed/recount cycle terminates)');

-- R2: ANONYMOUS (no reporter_id) + visible + nuevo. SCEN-006 anonymous case +
-- the SCEN-001/003/004 working report.
-- R3: hidden (is_visible = false) -> not validatable (SCEN-005).
-- R4: resuelto -> not validatable (SCEN-005).
-- R5: a second anonymous report, used only for the SCEN-010 ordering pair.
insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select x.id, null, c.id, x.status,
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, x.is_visible
from (values
  ('22222222-0000-0000-0000-000000000002'::uuid, 'nuevo'::public.report_status,    true),
  ('33333333-0000-0000-0000-000000000003'::uuid, 'nuevo'::public.report_status,    false),
  ('44444444-0000-0000-0000-000000000004'::uuid, 'resuelto'::public.report_status, true),
  ('55555555-0000-0000-0000-000000000005'::uuid, 'nuevo'::public.report_status,    true)
) as x(id, status, is_visible)
cross join lateral (select id from public.categories where slug = 'bache') c;

-- ---------------------------------------------------------------------------
-- SCEN-006: author-seed counts.
-- ---------------------------------------------------------------------------
select is(
  (select verified_count from public.reports where id = '11111111-0000-0000-0000-000000000001')::int,
  1,
  'SCEN-006: an AUTHORED report has verified_count = 1 immediately (author seed)');

select ok(
  exists (select 1 from public.report_validations
          where report_id = '11111111-0000-0000-0000-000000000001'
            and validator_id = 'b0000000-0000-0000-0000-0000000000b1'),
  'SCEN-006: the author seed row exists (verified, validator_id = author)');

select is(
  (select verified_count from public.reports where id = '22222222-0000-0000-0000-000000000002')::int,
  0,
  'SCEN-006: an ANONYMOUS report (no reporter_id) starts at verified_count = 0');

-- ---------------------------------------------------------------------------
-- SCEN-001: a 2nd distinct authenticated user confirms the authored R1.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select public.validate_report('11111111-0000-0000-0000-000000000001', null) $$,
  'SCEN-001: a 2nd authenticated user can confirm the report');
reset role;

select is(
  (select count(*) from public.report_validations
   where report_id = '11111111-0000-0000-0000-000000000001'
     and validator_id = 'c0000000-0000-0000-0000-0000000000c1')::int,
  1,
  'SCEN-001: a verified row exists for the 2nd user (validator_id set, ip_hash null)');

select is(
  (select verified_count from public.reports where id = '11111111-0000-0000-0000-000000000001')::int,
  2,
  'SCEN-001: verified_count = 2 after the 2nd authenticated confirm');

-- ---------------------------------------------------------------------------
-- SCEN-003: an anonymous confirm on R2 (anon_count rises, verified unchanged,
-- priority_score read from the column matches the formula).
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select lives_ok(
  $$ select public.validate_report('22222222-0000-0000-0000-000000000002', 'hash1') $$,
  'SCEN-003: an anonymous visitor can confirm with an ip_hash');
reset role;

select is(
  (select anon_count from public.reports where id = '22222222-0000-0000-0000-000000000002')::int,
  1,
  'SCEN-003: anon_count rises to 1');

select is(
  (select verified_count from public.reports where id = '22222222-0000-0000-0000-000000000002')::int,
  0,
  'SCEN-003: verified_count is unchanged by an anonymous confirm');

-- priority_score asserted by READING the generated column (not recomputed in the
-- test — the B3.3 false-green lesson). With verified=0, anon=1 -> 0 + 1/4 = 0.
select is(
  (select priority_score from public.reports where id = '22222222-0000-0000-0000-000000000002')::int,
  (select verified_count + anon_count / 4 from public.reports where id = '22222222-0000-0000-0000-000000000002')::int,
  'SCEN-003: priority_score (column) equals verified_count + anon_count / 4');

-- ---------------------------------------------------------------------------
-- SCEN-004: a 2nd IDENTICAL anonymous call (same ip_hash) is idempotent.
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  (select newly_added from public.validate_report('22222222-0000-0000-0000-000000000002', 'hash1')),
  false,
  'SCEN-004: a repeat confirm (same ip_hash) reports newly_added = false');
reset role;

select is(
  (select anon_count from public.reports where id = '22222222-0000-0000-0000-000000000002')::int,
  1,
  'SCEN-004: the repeat confirm adds no row — anon_count unchanged (still 1)');

-- ---------------------------------------------------------------------------
-- SCEN-005: validate_report against a hidden (R3) and a resuelto (R4) report
-- raises P0001 and inserts nothing.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.validate_report('33333333-0000-0000-0000-000000000003', null) $$,
  'P0001', null,
  'SCEN-005: confirming a HIDDEN report raises P0001 (not validatable)');
select throws_ok(
  $$ select public.validate_report('44444444-0000-0000-0000-000000000004', null) $$,
  'P0001', null,
  'SCEN-005: confirming a RESUELTO report raises P0001 (not validatable)');
reset role;

select is(
  (select count(*) from public.report_validations
   where report_id in ('33333333-0000-0000-0000-000000000003',
                       '44444444-0000-0000-0000-000000000004'))::int,
  0,
  'SCEN-005: the rejected confirms inserted nothing');

-- ---------------------------------------------------------------------------
-- misc: an anonymous confirm with an EMPTY ip_hash raises 22023.
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select throws_ok(
  $$ select public.validate_report('22222222-0000-0000-0000-000000000002', '') $$,
  '22023',
  null,
  'misc: an anonymous confirm with an empty ip_hash raises 22023');
reset role;

-- ---------------------------------------------------------------------------
-- SCEN-008: RLS. The 2nd citizen (c1) has exactly one row (their R1 confirm) and
-- sees only it; the anon ROLE sees 0 rows; a direct client INSERT is refused
-- (42501, no insert policy); the admin sees all rows.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select is(
  (select count(*) from public.report_validations)::int,
  1,
  'SCEN-008: select-own returns only the caller''s rows (c1 sees only their own)');

-- A direct INSERT bypassing the RPC is refused: SELECT is granted but no INSERT
-- privilege/policy exists for clients (only the DEFINER RPC/triggers write).
select throws_ok(
  $$ insert into public.report_validations (report_id, validator_id)
     values ('22222222-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-0000000000c1') $$,
  '42501', null,
  'SCEN-008: a direct client INSERT is refused (no insert policy — RPC-only writes)');
reset role;

set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  (select count(*) from public.report_validations)::int,
  0,
  'SCEN-008: an anonymous client sees 0 rows (cannot enumerate the table)');
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select ok(
  (select count(*) from public.report_validations)::int >= 3,
  'SCEN-008: an admin sees ALL validation rows (R1 author + R1 c1 + R2 anon)');
reset role;

-- ---------------------------------------------------------------------------
-- SCEN-010: two reports with different priority_scores order by priority_score
-- DESC. R5 gets 4 anon confirms -> priority 1; R2 has 1 anon -> priority 0.
-- ---------------------------------------------------------------------------
insert into public.report_validations (report_id, ip_hash) values
  ('55555555-0000-0000-0000-000000000005', 'h1'),
  ('55555555-0000-0000-0000-000000000005', 'h2'),
  ('55555555-0000-0000-0000-000000000005', 'h3'),
  ('55555555-0000-0000-0000-000000000005', 'h4');

select is(
  (select id from public.reports
   where id in ('22222222-0000-0000-0000-000000000002',
                '55555555-0000-0000-0000-000000000005')
   order by priority_score desc, id
   limit 1),
  '55555555-0000-0000-0000-000000000005'::uuid,
  'SCEN-010: the higher priority_score report orders first (priority_score DESC)');

-- ---------------------------------------------------------------------------
-- Grants probe: anon may EXECUTE validate_report (intentional — anonymous
-- corroboration); anon may NOT EXECUTE the recount trigger function.
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('anon', 'public.validate_report(uuid, text)', 'EXECUTE'),
  'grant: anon CAN EXECUTE validate_report (anonymous corroboration is intended)');

select ok(
  not has_function_privilege('anon', 'public.report_validations_recount()', 'EXECUTE'),
  'grant: anon CANNOT EXECUTE the recount trigger function');

select * from finish();
rollback;
