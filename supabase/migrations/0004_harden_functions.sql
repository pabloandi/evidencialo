-- 0004_harden_functions.sql
-- Remediate security-linter findings from 0002/0003:
--  - SECURITY DEFINER helpers exposed via PostgREST RPC (is_staff, handle_new_user)
--  - mutable search_path on set_updated_at
--
-- is_staff must stay SECURITY DEFINER (otherwise it recurses through the
-- profiles_select_staff policy). The right fix is to move it to a `private`
-- schema that PostgREST does not expose, then repoint the policies.

create schema if not exists private;
grant usage on schema private to anon, authenticated;

-- Relocate is_staff to `private` (not reachable via /rest/v1/rpc).
create or replace function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role in ('staff', 'admin')
  );
$$;
revoke execute on function private.is_staff() from public;
grant execute on function private.is_staff() to anon, authenticated;

-- Repoint every policy from public.is_staff() to private.is_staff().
drop policy profiles_select_staff on public.profiles;
create policy profiles_select_staff on public.profiles
  for select using (private.is_staff());

drop policy reports_select_staff on public.reports;
create policy reports_select_staff on public.reports
  for select using (private.is_staff());

drop policy reports_update_staff on public.reports;
create policy reports_update_staff on public.reports
  for update using (private.is_staff()) with check (private.is_staff());

drop policy report_media_select on public.report_media;
create policy report_media_select on public.report_media
  for select using (
    exists (
      select 1 from public.reports r
      where r.id = report_media.report_id
        and (r.is_visible or r.reporter_id = (select auth.uid()) or private.is_staff())
    )
  );

drop policy report_status_history_select_staff on public.report_status_history;
create policy report_status_history_select_staff on public.report_status_history
  for select using (private.is_staff());

drop function public.is_staff();

-- Lock down the trigger functions: set search_path and revoke RPC execute.
-- Trigger invocation does not require EXECUTE on the function, so revoking is safe.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
