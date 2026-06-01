-- 0003_rls_policies.sql
-- Row Level Security as defense-in-depth. The API writes with the service role
-- (which bypasses RLS), but these policies guard against any direct access.
--
-- Reads:
--   - reports: public sees only is_visible; a citizen sees their own; staff see all.
--   - categories: public.
--   - report_media: visible iff the parent report is visible/owned/staff.
--   - report_status_history: staff/admin only.
--   - profiles: own + staff.
-- Writes:
--   - reports status: staff/admin only (E3). All other writes go through the
--     API with the service role; no permissive insert policies for clients.

-- Table grants. RLS still gates rows; grants gate which verbs the role may
-- attempt at all. Explicit so behavior does not depend on default privileges.
grant select on
  public.reports, public.categories, public.report_media,
  public.report_status_history, public.profiles
  to anon, authenticated;
grant update on public.reports to authenticated; -- gated to staff by RLS below

alter table public.profiles               enable row level security;
alter table public.categories             enable row level security;
alter table public.reports                enable row level security;
alter table public.report_media           enable row level security;
alter table public.report_status_history  enable row level security;

-- profiles
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());
create policy profiles_select_staff on public.profiles
  for select using (public.is_staff());

-- categories (public read)
create policy categories_select_all on public.categories
  for select using (true);

-- reports (reads)
create policy reports_select_public on public.reports
  for select using (is_visible = true);
create policy reports_select_own on public.reports
  for select using (reporter_id = auth.uid());
create policy reports_select_staff on public.reports
  for select using (public.is_staff());

-- reports (status updates: staff/admin only)
create policy reports_update_staff on public.reports
  for update using (public.is_staff()) with check (public.is_staff());

-- report_media (read tied to parent report visibility/ownership/staff)
create policy report_media_select on public.report_media
  for select using (
    exists (
      select 1 from public.reports r
      where r.id = report_media.report_id
        and (r.is_visible or r.reporter_id = auth.uid() or public.is_staff())
    )
  );

-- report_status_history (staff/admin only)
create policy report_status_history_select_staff on public.report_status_history
  for select using (public.is_staff());
