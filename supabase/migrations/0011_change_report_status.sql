-- 0011_change_report_status.sql
-- Audited, atomic status-change write path for the staff panel (step13).
--
-- `public.change_report_status` updates `reports.status`, appends a
-- `report_status_history` row, and (when moving to `resuelto`) stamps
-- `resolved_at` — all in ONE transaction. The status can NEVER change without
-- its audit row, and authz lives in the DB (defense in depth over the route's
-- 403): the function gates on `private.is_staff()` and raises `forbidden`
-- otherwise.
--
-- SECURITY DEFINER is REQUIRED here (unlike `reports_in_view` in step11, which
-- was correctly demoted to INVOKER). The function performs an UPDATE on
-- `reports` AND an INSERT into `report_status_history` as a single privileged,
-- atomic unit. As INVOKER it could not guarantee that the audit insert is
-- inseparable from the status update under the caller's RLS, which is the whole
-- point of the audited write. This is NOT a privilege escalation: the FIRST
-- statement is `if not private.is_staff() then raise forbidden`, so only
-- staff/admin reach the writes, and the only thing it writes beyond the status
-- is the audit trail itself (with `changed_by = auth.uid()`). This pre-empts the
-- 0029 advisor (authenticated may execute a DEFINER function) — the grant is
-- intentional and the function is its own security boundary.
create or replace function public.change_report_status(
  p_report_id uuid,
  p_to_status public.report_status,
  p_note text default null
)
returns table(id uuid, status public.report_status, resolved_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from public.report_status;
begin
  -- DB-layer authz: the security boundary does not rest on the HTTP route.
  if not private.is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Lock the row and capture the pre-change status for the audit's from_status.
  -- A missing report is a not-found condition the route maps to 404.
  select r.status into v_from
  from public.reports r
  where r.id = p_report_id
  for update;

  if not found then
    raise exception 'report not found' using errcode = 'P0002';
  end if;

  -- No-op: the requested status equals the current one. Do not write a junk
  -- audit row and do not re-stamp resolved_at; return the current row so the
  -- UI still refreshes cleanly. (SCEN-H01)
  if v_from = p_to_status then
    return query
      select r.id, r.status, r.resolved_at
      from public.reports r
      where r.id = p_report_id;
    return;
  end if;

  -- Apply the change. Moving to `resuelto` stamps resolved_at; any other target
  -- leaves an existing resolved_at untouched (we do not clear it on un-resolve).
  update public.reports
  set status = p_to_status,
      updated_at = now(),
      resolved_at = case when p_to_status = 'resuelto' then now() else reports.resolved_at end
  where reports.id = p_report_id;

  -- Audit row — inseparable from the update above (same transaction).
  -- A blank/whitespace note collapses to NULL.
  insert into public.report_status_history (report_id, from_status, to_status, changed_by, note)
  values (
    p_report_id,
    v_from,
    p_to_status,
    (select auth.uid()),
    nullif(btrim(coalesce(p_note, '')), '')
  );

  -- Echo the new row so the API can return it without a second read.
  return query
  select r.id, r.status, r.resolved_at
  from public.reports r
  where r.id = p_report_id;
end;
$$;

-- Only authenticated callers may invoke it; anon never can. The internal
-- `private.is_staff()` gate further restricts the effect to staff/admin.
revoke execute on function public.change_report_status(uuid, public.report_status, text) from public;
grant execute on function public.change_report_status(uuid, public.report_status, text) to authenticated;
