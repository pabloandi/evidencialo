-- 0007_visibility_trigger.sql
-- reports.is_visible is the SINGLE source of truth, owned by the database.
--
-- Two write paths set report_media.processing_state: the image path
-- (/api/media, step07) and the video path (Edge Function, later). Neither may
-- decide visibility on its own — that would race (both flip the report when the
-- other still has pending work). Instead this trigger RECOMPUTES is_visible from
-- the full set of a report's media on every media change, in BOTH directions:
--   is_visible := report has >=1 media row AND no media is 'pending'/'failed'.
-- So a late 'failed' un-publishes a previously visible report (design §6:
-- "un reporte con media failed nunca se publica"), and the last pending media
-- turning 'processed' publishes it. A report with zero media rows is never
-- touched and stays invisible (born false, step03).
--
-- AFTER trigger returning NULL; writes the report only when the value actually
-- changes (is distinct from), so there are no needless updates and no recursion.
--
-- CONCURRENCY (the race this trigger exists to close, both directions): under
-- READ COMMITTED two writers finishing the LAST TWO pending media near-
-- simultaneously (image path + video Edge Function) would each fail to see the
-- other's uncommitted 'processed' row and both compute is_visible=false,
-- stranding the report invisible forever. To prevent that, the trigger takes a
-- `for no key update` lock on the parent report row BEFORE recomputing, so the
-- recomputes for one report serialize: the later transaction blocks until the
-- earlier commits, then re-reads the committed sibling state and computes the
-- correct value. `for no key update` (not `for update`) avoids blocking FK
-- checks needlessly, since is_visible is not part of any key.
--
-- SECURITY DEFINER (owner = the migration superuser, who can write reports and
-- bypass RLS): the recompute must update a row the triggering role may not.
-- DEFINER makes it robust regardless of which role mutated report_media — it no
-- longer depends on the fragile invariant that report_media has no client write
-- grant. Consistent with the established pattern (create_report, is_staff,
-- handle_new_user are all SECURITY DEFINER for the same "must write a table the
-- invoker may not" reason). search_path is locked to '' (every reference fully
-- qualified) and EXECUTE is revoked from PUBLIC/anon/authenticated, so the
-- DEFINER function is not RPC-reachable — security-advisor clean (trigger
-- invocation does not require EXECUTE on the function).

create or replace function public.refresh_report_visibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id uuid;
  v_visible   boolean;
begin
  v_report_id := coalesce(new.report_id, old.report_id);

  -- Serialize concurrent recomputes for the same report so each sees the other
  -- writer's committed sibling state (closes the dual-writer READ COMMITTED race
  -- that would otherwise strand the report invisible). Taken BEFORE the select.
  perform 1 from public.reports where id = v_report_id for no key update;

  -- Visible iff the report has at least one media row and NONE are pending/failed.
  select exists (select 1 from public.report_media where report_id = v_report_id)
     and not exists (select 1 from public.report_media
                     where report_id = v_report_id
                       and processing_state in ('pending', 'failed'))
    into v_visible;

  update public.reports
     set is_visible = v_visible
   where id = v_report_id
     and is_visible is distinct from v_visible;  -- only write when it changes

  return null;  -- AFTER trigger
end;
$$;

create trigger report_media_visibility
  after insert or delete or update on public.report_media
  for each row execute function public.refresh_report_visibility();

revoke execute on function public.refresh_report_visibility() from public, anon, authenticated;
