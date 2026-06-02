-- custom_access_token_hook tests (pgTAP). Run with: supabase test db
-- Encodes the mechanism AC3 relies on: the hook injects the CURRENT
-- profiles.role as the `user_role` JWT claim, so after an admin changes a role
-- and the user's token is refreshed, the claim reflects the new role.
-- Also asserts the privilege lockdown: only `supabase_auth_admin` may run it.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

select plan(7);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; handle_new_user seeds profiles with role 'citizen')
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'citizen@test.local'),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'staff@test.local');

update public.profiles set role = 'staff' where id = '33333333-3333-3333-3333-333333333333';

-- ---------------------------------------------------------------------------
-- Hook logic: claim reflects the current profiles.role
-- ---------------------------------------------------------------------------
select is(
  public.custom_access_token_hook(
    jsonb_build_object(
      'user_id', '33333333-3333-3333-3333-333333333333',
      'claims', jsonb_build_object('sub', '33333333-3333-3333-3333-333333333333')
    )
  ) -> 'claims' ->> 'user_role',
  'staff',
  'AC3: hook injects user_role=staff for a staff profile');

select is(
  public.custom_access_token_hook(
    jsonb_build_object(
      'user_id', '11111111-1111-1111-1111-111111111111',
      'claims', jsonb_build_object('sub', '11111111-1111-1111-1111-111111111111')
    )
  ) -> 'claims' ->> 'user_role',
  'citizen',
  'hook injects user_role=citizen for a citizen profile');

select is(
  public.custom_access_token_hook(
    jsonb_build_object(
      'user_id', '99999999-9999-9999-9999-999999999999',
      'claims', jsonb_build_object('sub', '99999999-9999-9999-9999-999999999999')
    )
  ) -> 'claims' -> 'user_role',
  'null'::jsonb,
  'hook sets user_role to JSON null when no profile exists');

-- ---------------------------------------------------------------------------
-- Privilege lockdown: only the Auth admin runs the hook (not exposed via RPC)
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'execute'),
  'supabase_auth_admin may execute the hook');

select ok(
  not has_function_privilege('authenticated', 'public.custom_access_token_hook(jsonb)', 'execute'),
  'authenticated may NOT execute the hook (no RPC exposure)');

-- ---------------------------------------------------------------------------
-- Off-nominal events must never crash (a raise would block ALL token issuance)
-- ---------------------------------------------------------------------------
select is(
  public.custom_access_token_hook(
    jsonb_build_object('user_id', 'not-a-uuid', 'claims', jsonb_build_object('sub', 'x'))
  ) -> 'claims' -> 'user_role',
  'null'::jsonb,
  'malformed user_id: hook returns user_role=null without raising');

select is(
  public.custom_access_token_hook(
    jsonb_build_object('user_id', '11111111-1111-1111-1111-111111111111')
  ) -> 'claims' ->> 'user_role',
  'citizen',
  'absent claims object: hook synthesizes claims and still resolves the role');

select * from finish();
rollback;
