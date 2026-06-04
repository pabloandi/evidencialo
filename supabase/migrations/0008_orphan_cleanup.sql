-- 0008_orphan_cleanup.sql
-- Server-side orphan selection for the daily cleanup cron (step10 hardening).
--
-- The first cut selected orphans with a no-LIMIT/no-order two-query sweep in the
-- service. That is wrong at scale: PostgREST silently caps a result at 1000 rows
-- (so a larger backlog is truncated and the tail never drains), and a sequential
-- per-orphan delete loop over an unbounded set can exceed the function's
-- maxDuration. It also discovered candidates ONLY via pending media, so an
-- abandoned report that never got a single media row (zero media) was never
-- reclaimed.
--
-- This migration moves selection into ONE bounded, ordered query exposed as a
-- SECURITY DEFINER function. The service asks for at most `p_limit` orphans,
-- OLDEST-first, so repeated cron runs drain a backlog deterministically and
-- never starve the tail (SCEN-H01).
--
-- An orphan is an invisible report, older than the cutoff, that is EITHER
-- waiting on a pending upload OR has no media at all (SCEN-H02). A report whose
-- only media is `failed` is NOT an orphan: processing happened and the panel
-- keeps it for review (SCEN-004) — it has a media row, none pending, so both
-- branches exclude it.

-- Partial index for the pending-media existence probe (and the cutoff scan stays
-- on the existing reports_created_at_idx). Keeps find_orphan_reports cheap as
-- report_media grows.
create index report_media_pending_idx
  on public.report_media (report_id)
  where processing_state = 'pending';

-- SECURITY DEFINER (owner = the migration superuser, who bypasses RLS): the
-- sweep reads reports/report_media regardless of the caller's RLS context.
-- search_path is locked to '' (every reference fully qualified) and EXECUTE is
-- revoked from PUBLIC/anon/authenticated, consistent with create_report (0006)
-- and refresh_report_visibility (0007). The service-role caller (the cron's
-- service-role key) retains EXECUTE via its inherent privileges; no explicit
-- grant is required because service_role bypasses the REVOKE on its own
-- functions the way it does for the other definer functions in this schema —
-- but we grant it explicitly to match the create_report pattern and be robust.
create or replace function public.find_orphan_reports(
  p_cutoff timestamptz,
  p_limit  int
)
returns setof uuid
language sql
security definer
set search_path = ''
as $$
  select r.id
  from public.reports r
  where r.is_visible = false
    and r.created_at < p_cutoff
    and (
      exists (
        select 1 from public.report_media m
        where m.report_id = r.id and m.processing_state = 'pending'
      )
      or not exists (
        select 1 from public.report_media m
        where m.report_id = r.id
      )
    )
  order by r.created_at asc
  limit p_limit;
$$;

revoke execute on function public.find_orphan_reports(timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.find_orphan_reports(timestamptz, int)
  to service_role;
