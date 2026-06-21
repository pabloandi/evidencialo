-- solver_donation_channels tests (pgTAP). Run with: supabase test db
--
-- Arbiter for the DB half of subsystem D, chunk D1 (donation-channels.scenarios.md
-- SCEN-001, 002, 003, 004, 005, 010, 012). A verified solver self-manages their own
-- donation channels through two owner-gated SECURITY DEFINER RPCs
-- (set_solver_donation_channel / delete_solver_donation_channel); the solver_id is
-- ALWAYS auth.uid(), never a parameter, so a solver can only ever write their own
-- channels. Channels are public (anon SELECT); the history audit table is admin-only.
-- The typed allowlist + the account_kind coupling are enforced by table CHECKs (the
-- single source of truth) -> an invalid type / coupling raises 23514 from inside the
-- DEFINER. Covers:
--   SCEN-001  set: S sets a nequi channel -> exactly one channel row for S (nequi /
--             that value) AND one `set` history row for S.
--   SCEN-002  owner-only: (a) T's call writes T's OWN row (solver_id = auth.uid()),
--             S's rows unchanged; (b) a non-solver authenticated caller -> 42501.
--             The RPC has no p_solver_id, so forging another solver_id is structurally
--             impossible.
--   SCEN-003  allowlist: type='crypto' raises the CHECK (23514) and creates no row.
--   SCEN-004  coupling: bancolombia WITHOUT account_kind throws; nequi/daviplata/paypal
--             WITH account_kind throws; valid bancolombia-with-kind + valid
--             nequi-without both succeed.
--   SCEN-005  upsert: a 2nd set of the same type keeps exactly one row (new value) and
--             writes a 2nd `set` history row (UNIQUE(solver_id,type), never duplicate).
--   SCEN-010  RLS: as anon, solver_donation_channels returns S's rows (public);
--             solver_donation_channel_history returns 0 rows (admin-only).
--   SCEN-012  delete: deleting S's nequi removes the row and writes a `delete` history row.
--
-- Effects are asserted by READING THE TABLES, never by recomputing (the B3.3
-- false-green lesson). Fixtures are ISOLATED (built here) so this passes on a fresh
-- `supabase db reset` alongside the other files. Identity is switched with
-- `set local role authenticated` + request.jwt.claims exactly like
-- report_disputes_test.sql; state assertions `reset role` first so they read as
-- superuser (bypassing RLS), except the explicit RLS tests which assert UNDER anon.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

grant execute on all functions in schema extensions to anon, authenticated;

select plan(31);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS).
--   S — verified solver (has a solver_profiles row). The channel subject.
--   T — a 2nd verified solver, proves writes land on the caller (auth.uid()).
--   U — a non-solver authenticated citizen, proves the 42501 gate.
-- handle_new_user auto-creates a public.profiles row (role citizen) per auth.users.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000051', 'authenticated', 'authenticated', 'don-solverS@test.local'),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000052', 'authenticated', 'authenticated', 'don-solverT@test.local'),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000053', 'authenticated', 'authenticated', 'don-roleonlyW@test.local'),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'don-citizenU@test.local');

update public.profiles set role = 'solver' where id = '50000000-0000-0000-0000-000000000051';
update public.profiles set role = 'solver' where id = '50000000-0000-0000-0000-000000000052';
-- W has role='solver' but NO solver_profiles row (a corrupt/partial state): the
-- gate must still refuse it cleanly (the FK precondition is the real gate).
update public.profiles set role = 'solver' where id = '50000000-0000-0000-0000-000000000053';
-- U stays a citizen (the default role) -> no solver_profiles row.

insert into public.solver_profiles (id, handle, type) values
  ('50000000-0000-0000-0000-000000000051', 'don-solver-s', 'org'),
  ('50000000-0000-0000-0000-000000000052', 'don-solver-t', 'org');

-- ---------------------------------------------------------------------------
-- SCEN-001 (owner sets a channel + audit row): S sets a nequi channel.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000051', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select public.set_solver_donation_channel('nequi', '3001234567') $$,
  'SCEN-001: a verified solver (S) can set a nequi channel');
reset role;

select is(
  (select count(*) from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi')::int,
  1,
  'SCEN-001: exactly one nequi channel row exists for S');

select is(
  (select value from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi'),
  '3001234567',
  'SCEN-001: the nequi channel stores the value S supplied');

select is(
  (select count(*) from public.solver_donation_channel_history
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi' and action = 'set')::int,
  1,
  'SCEN-001: a `set` history row is recorded for S''s nequi channel');

-- ---------------------------------------------------------------------------
-- SCEN-002a (owner-only: T's call writes T's OWN row): T sets a nequi channel.
-- solver_id is forced to auth.uid() = T; S's row is untouched.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000052', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select public.set_solver_donation_channel('nequi', '3007654321') $$,
  'SCEN-002: a 2nd solver (T) can set their own nequi channel');
reset role;

select is(
  (select solver_id from public.solver_donation_channels
   where type = 'nequi' and value = '3007654321'),
  '50000000-0000-0000-0000-000000000052'::uuid,
  'SCEN-002: T''s write lands on T''s own row (solver_id = auth.uid(), never client-supplied)');

select is(
  (select value from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi'),
  '3001234567',
  'SCEN-002: S''s nequi channel is unchanged after T''s call');

-- SCEN-002b (a non-solver authenticated caller is refused 42501).
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.set_solver_donation_channel('nequi', '3009999999') $$,
  '42501', 'forbidden',
  'SCEN-002: a non-solver authenticated caller is refused (42501)');
reset role;

select is(
  (select count(*) from public.solver_donation_channels where value = '3009999999')::int,
  0,
  'SCEN-002: the refused non-solver call created no row');

-- SCEN-002c (role='solver' WITHOUT a solver_profiles row): the gate is the
-- solver_profiles row, not merely the role -> W is refused cleanly with 42501
-- (never an opaque FK 23503), and no row is created.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000053', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.set_solver_donation_channel('nequi', '3008888888') $$,
  '42501', 'forbidden',
  'SCEN-002: a role=solver WITHOUT a solver_profiles row is refused 42501 (not FK 23503)');
reset role;

select is(
  (select count(*) from public.solver_donation_channels where value = '3008888888')::int,
  0,
  'SCEN-002: the refused role-only call created no row');

-- ---------------------------------------------------------------------------
-- SCEN-003 (type allowlist enforced): set 'crypto' -> CHECK (23514), no row.
-- The table CHECK is the single source of truth; the DEFINER surfaces 23514.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000051', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select public.set_solver_donation_channel('crypto', '0xdeadbeef') $$,
  '23514', null,
  'SCEN-003: a type outside the allowlist (crypto) raises the check constraint (23514)');
reset role;

select is(
  (select count(*) from public.solver_donation_channels where type = 'crypto')::int,
  0,
  'SCEN-003: no crypto channel row was created');

-- ---------------------------------------------------------------------------
-- SCEN-004 (account_kind coupling, BOTH directions): bancolombia WITHOUT a kind
-- throws; every other type WITH a kind throws (test nequi AND daviplata/paypal so
-- it is not nequi-only); valid bancolombia-with-kind + valid nequi-without succeed.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000051', 'role', 'authenticated')::text, true);

select throws_ok(
  $$ select public.set_solver_donation_channel('bancolombia', '12345678901', null) $$,
  '23514', null,
  'SCEN-004: bancolombia WITHOUT account_kind is rejected (coupling CHECK)');

select throws_ok(
  $$ select public.set_solver_donation_channel('nequi', '3001112222', 'ahorros') $$,
  '23514', null,
  'SCEN-004: nequi WITH account_kind is rejected (coupling CHECK, non-bancolombia => NULL)');

select throws_ok(
  $$ select public.set_solver_donation_channel('paypal', 'someuser', 'corriente') $$,
  '23514', null,
  'SCEN-004: paypal WITH account_kind is rejected (coupling CHECK, non-bancolombia => NULL)');

select lives_ok(
  $$ select public.set_solver_donation_channel('bancolombia', '12345678901', 'ahorros') $$,
  'SCEN-004: a valid bancolombia WITH account_kind succeeds');

-- (S already set a valid nequi WITHOUT account_kind in SCEN-001 -> the
-- non-bancolombia-without-kind branch is proven there; assert it still holds.)
select is(
  (select account_kind from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi'),
  null::text,
  'SCEN-004: a valid nequi has account_kind NULL');
reset role;

select is(
  (select account_kind from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'bancolombia'),
  'ahorros',
  'SCEN-004: the valid bancolombia stored account_kind = ahorros');

-- ---------------------------------------------------------------------------
-- SCEN-005 (one per type, upsert not duplicate): S sets nequi again with a new
-- value -> still exactly one nequi row (new value), and a 2nd `set` history row.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000051', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select public.set_solver_donation_channel('nequi', '3009998877', null, null, '{"ip":"1.2.3.4","ua":"pgtap"}'::jsonb) $$,
  'SCEN-005: S sets nequi a second time with a new value (+ request meta)');
reset role;

select is(
  (select count(*) from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi')::int,
  1,
  'SCEN-005: still exactly ONE nequi row for S after the second set (upsert, not duplicate)');

select is(
  (select value from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi'),
  '3009998877',
  'SCEN-005: the nequi row now holds the new value');

select is(
  (select count(*) from public.solver_donation_channel_history
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi' and action = 'set')::int,
  2,
  'SCEN-005: a second `set` history row exists (audit of the change)');

-- Audit fidelity: the upsert's `set` history row (identified by its new value,
-- since now() is constant within the test transaction) captured the PRIOR
-- snapshot in old_value, the actor in changed_by, and the route-supplied
-- request_meta in its own column. Reading these back closes the
-- "history row exists but is empty" regression that counts alone cannot catch.
select is(
  (select old_value->>'value' from public.solver_donation_channel_history
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi'
     and action = 'set' and new_value->>'value' = '3009998877'),
  '3001234567',
  'SCEN-005: the upsert history row captured the prior value in old_value');

select is(
  (select changed_by from public.solver_donation_channel_history
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi'
     and action = 'set' and new_value->>'value' = '3009998877'),
  '50000000-0000-0000-0000-000000000051'::uuid,
  'SCEN-005: the history row records changed_by = S (auth.uid())');

select is(
  (select request_meta->>'ip' from public.solver_donation_channel_history
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi'
     and action = 'set' and new_value->>'value' = '3009998877'),
  '1.2.3.4',
  'SCEN-005: the history row stored the route-supplied request_meta (IP/UA)');

-- ---------------------------------------------------------------------------
-- SCEN-010 (channels are public, the audit log is not): as anon, channels are
-- readable; history returns 0 rows (admin-only).
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

select ok(
  (select count(*) from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051')::int >= 1,
  'SCEN-010: an anonymous client CAN read S''s solver_donation_channels (public)');

select is(
  (select count(*) from public.solver_donation_channel_history)::int,
  0,
  'SCEN-010: an anonymous client sees 0 solver_donation_channel_history rows (admin-only)');
reset role;

-- ---------------------------------------------------------------------------
-- SCEN-012 (delete removes the channel + audit row): S deletes their nequi.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '50000000-0000-0000-0000-000000000051', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select public.delete_solver_donation_channel('nequi') $$,
  'SCEN-012: S can delete their nequi channel');
reset role;

select is(
  (select count(*) from public.solver_donation_channels
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi')::int,
  0,
  'SCEN-012: S''s nequi channel row is gone after the delete');

select is(
  (select count(*) from public.solver_donation_channel_history
   where solver_id = '50000000-0000-0000-0000-000000000051' and type = 'nequi' and action = 'delete')::int,
  1,
  'SCEN-012: a `delete` history row is recorded for S''s nequi channel');

select * from finish();
rollback;
