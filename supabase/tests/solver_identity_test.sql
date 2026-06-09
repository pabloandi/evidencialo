-- solver_identity_test.sql — grant_solver RPC + solver_profiles RLS (pgTAP).
-- Run with: supabase test db
--
-- Arbiter for chunk B1 (solver identity & admin grant infra,
-- solver-resolution.scenarios.md). Covers SCEN-010 and the B1.3 acceptance:
--   SCEN-010  admin grant sets profiles.role='solver' AND inserts a
--             solver_profiles row (handle/type correct)
--   SCEN-010  a non-admin (citizen) calling grant_solver raises forbidden
--             (42501) and NOTHING changes (role intact, no profile row)
--   SCEN-010  grants show no anon/public EXECUTE on grant_solver; authenticated has it
--   B1.3      granting a p_user_id with NO profiles row raises cleanly (P0002)
--             and creates NO orphan solver_profiles row
--   spec      solver_profiles RLS: public can SELECT; clients CANNOT
--             insert/update directly (writes only via the DEFINER RPC)
--   spec      lower(handle) uniqueness rejects a case-different duplicate handle
--
-- Identity is switched with `set local role authenticated` +
-- `request.jwt.claims` (sub) exactly like change_report_status_test.sql; the
-- DEFINER function runs but its internal private.is_admin() gate reads
-- auth.uid() from those claims.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(16);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'citizen@test.local'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'target@test.local'),
  ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated', 'admin@test.local');

-- handle_new_user created profiles (role citizen). Promote the third to admin.
update public.profiles set role = 'admin' where id = '44444444-4444-4444-4444-444444444444';

-- ---------------------------------------------------------------------------
-- SCEN-010 (DB boundary): a CITIZEN calling grant_solver is refused, and
-- nothing changes. Run this FIRST so the target profile is still a `citizen`
-- with no solver_profiles row for the admin happy-path below.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ select public.grant_solver('22222222-2222-2222-2222-222222222222', 'alcaldia-cali', 'government') $$,
  '42501',
  'only admin',
  'SCEN-010: a non-admin (citizen) calling grant_solver raises forbidden (42501)');
reset role;

select is(
  (select role from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  'citizen'::public.user_role,
  'SCEN-010: the target profile role is unchanged after the refused citizen call');

select is(
  (select count(*) from public.solver_profiles
   where id = '22222222-2222-2222-2222-222222222222')::int,
  0,
  'SCEN-010: no solver_profiles row was written for the refused citizen call');

-- ---------------------------------------------------------------------------
-- SCEN-010 (happy path): an ADMIN grant sets role='solver' AND inserts the
-- public solver profile with the supplied handle/type.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '44444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);

-- Invoke the RPC; a raise here would fail the test run.
select public.grant_solver('22222222-2222-2222-2222-222222222222', 'Alcaldia-Cali', 'government', 'Cuenta oficial');
reset role;

select is(
  (select role from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  'solver'::public.user_role,
  'SCEN-010: admin grant sets profiles.role = solver');

select is(
  (select handle from public.solver_profiles where id = '22222222-2222-2222-2222-222222222222'),
  'Alcaldia-Cali',
  'SCEN-010: admin grant inserts a solver_profiles row with the supplied handle');

select is(
  (select type from public.solver_profiles where id = '22222222-2222-2222-2222-222222222222'),
  'government',
  'SCEN-010: the inserted solver_profiles row carries the supplied type');

-- verified_by is captured from auth.uid() (the admin), never a client arg.
select is(
  (select verified_by from public.solver_profiles where id = '22222222-2222-2222-2222-222222222222'),
  '44444444-4444-4444-4444-444444444444'::uuid,
  'SCEN-010: verified_by equals the admin auth.uid() (no client-supplied attribution)');

-- ---------------------------------------------------------------------------
-- B1.3: granting a p_user_id with NO profiles row raises cleanly (P0002) and
-- creates NO orphan solver_profiles row.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '44444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ select public.grant_solver('99999999-9999-9999-9999-999999999999', 'ghost', 'org') $$,
  'P0002',
  'profile not found',
  'B1.3: granting a user with no profiles row raises not-found (P0002)');
reset role;

select is(
  (select count(*) from public.solver_profiles
   where id = '99999999-9999-9999-9999-999999999999')::int,
  0,
  'B1.3: no orphan solver_profiles row is created for the missing-profile grant');

-- ---------------------------------------------------------------------------
-- solver_profiles RLS: public can SELECT; a client (citizen/anon) CANNOT
-- write directly — inserts/updates only flow through the DEFINER RPC / service
-- role. A direct insert is blocked by the absence of any insert policy (no
-- permissive policy → WITH CHECK fails: 42501).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ insert into public.solver_profiles (id, handle, type)
     values ('11111111-1111-1111-1111-111111111111', 'self-grant', 'influencer') $$,
  '42501',
  'RLS: a citizen cannot INSERT into solver_profiles directly (no client write path)');

select throws_ok(
  $$ update public.solver_profiles set handle = 'hijacked'
     where id = '22222222-2222-2222-2222-222222222222' $$,
  '42501',
  'RLS: a citizen cannot UPDATE solver_profiles directly (no client write path)');

-- public read of the verified solver profile (the public identity surface).
select is(
  (select count(*) from public.solver_profiles
   where id = '22222222-2222-2222-2222-222222222222')::int,
  1,
  'RLS: a client can SELECT the public solver_profiles row');
reset role;

-- ---------------------------------------------------------------------------
-- lower(handle) uniqueness: a second profile whose handle differs only in case
-- collides with the existing 'Alcaldia-Cali'. Done as superuser (bypasses RLS)
-- to isolate the index constraint from the RLS write block above.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.solver_profiles (id, handle, type)
     values ('11111111-1111-1111-1111-111111111111', 'alcaldia-cali', 'government') $$,
  '23505',
  'lower(handle) uniqueness: a case-different duplicate handle is rejected (23505)');

-- ---------------------------------------------------------------------------
-- Grants: authenticated may EXECUTE grant_solver; anon and public may NOT
-- (Supabase default privileges grant public functions to anon, so anon is
-- revoked BY NAME in 0014). A regression that re-grants anon must fail here.
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated',
    'public.grant_solver(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'grant: authenticated can EXECUTE grant_solver');

select ok(
  not has_function_privilege('anon',
    'public.grant_solver(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'grant: anon CANNOT EXECUTE grant_solver');

select ok(
  not has_function_privilege('public',
    'public.grant_solver(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'grant: PUBLIC cannot EXECUTE grant_solver');

select * from finish();
rollback;
