-- 0005_role_jwt_hook.sql
-- Custom access token hook: expose profiles.role as the `user_role` JWT claim
-- so app-layer authz (and, optionally, RLS) can read the role without a join.
-- Deferred here from step03 because enabling the hook on the remote project is a
-- dashboard step (Authentication > Hooks); this migration only ships the
-- function + privileges. Local dev enables it via supabase/config.toml.
--
-- The Auth server runs this hook as the `supabase_auth_admin` role. We grant
-- execute to that role only and revoke it from anon/authenticated/public so the
-- function is never reachable through the PostgREST RPC surface.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_role public.user_role;
  claims jsonb;
begin
  -- Never let a malformed event abort token issuance (that would block ALL
  -- logins). Guard the cast and the claims object; on any uncertainty fall
  -- through to a null user_role, which the app gate treats as citizen.
  begin
    v_user_id := (event ->> 'user_id')::uuid;
  exception when others then
    v_user_id := null;
  end;

  claims := coalesce(event -> 'claims', '{}'::jsonb);

  if v_user_id is not null then
    select role into v_role from public.profiles where id = v_user_id;
  end if;

  claims := jsonb_set(
    claims,
    '{user_role}',
    case when v_role is not null then to_jsonb(v_role) else 'null'::jsonb end
  );

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- profiles has RLS enabled (0003); let the Auth admin read roles when the hook
-- runs (it executes with the supabase_auth_admin role, not the user's).
grant select on table public.profiles to supabase_auth_admin;
create policy profiles_select_auth_admin on public.profiles
  for select to supabase_auth_admin using (true);
