-- 0019_solver_reputation.sql
-- Subsystem C, chunk C1: solver reputation (DB layer).
--
-- Subsystem B verifies a solver with a binary badge; this migration turns that
-- badge into an EARNED, graded reputation computed from facts B already captures:
-- reports resolved (and still standing), resolutions that survived a dispute, and
-- resolutions reverted as false. The reputation is public DISPLAY (the solver
-- profile) plus an admin-panel SIGNAL — it NEVER gates a solver's powers and never
-- acts on its own. It reuses subsystem A's denormalized-counts-by-recompute-trigger
-- pattern (report_validations) so reads stay O(1).
--
-- The attribution gap it closes: when an admin REVERTS a dispute, resolve_dispute
-- (0017) nulls reports.resolved_by, so the solver whose resolution was reverted is
-- lost from both the report and the dispute. C captures the challenged solver at
-- the semantically correct moment — a dispute may only be filed against a `resuelto`
-- report (the insert RLS policy requires it), so at INSERT time reports.resolved_by
-- IS exactly the challenged solver. A BEFORE INSERT trigger stamps it, immune to the
-- later attribution strip.
--
-- What it adds, in order:
--   (a) report_disputes.disputed_solver_id uuid -> profiles(id) (nullable). Stamped
--       server-side by a BEFORE INSERT trigger from reports.resolved_by; the client
--       never supplies it (any payload value is overwritten unconditionally).
--   (b) report_disputes_stamp_solver — BEFORE INSERT trigger fn. DEFINER,
--       search_path=''. Reads reports.resolved_by FOR SHARE (pins the report row so a
--       concurrent resolve_dispute REVERT cannot null resolved_by between the insert
--       policy's status='resuelto' check and this read; without it that vanishingly
--       rare interleave would stamp NULL — under-attribution, never mis-attribution).
--   (c) solver_profiles.resolved_count / upheld_count / reverted_count
--       (int not null default 0): the three denormalized reputation counts.
--   (d) solver_reputation_recount_from_reports() — AFTER INSERT/UPDATE/DELETE on
--       reports. Recomputes resolved_count for each affected solver
--       ({OLD.resolved_by, NEW.resolved_by} minus null). resolved_count counts
--       `resuelto AND is_visible` reports, so it EQUALS the profile's resolved wall
--       (getSolverResolvedReports filters the same way) — a resolve increments, a
--       revert (nulls resolved_by) decrements, an is_visible flip (the visibility
--       trigger UPDATEs reports) re-counts. Only acts on ids that exist in
--       solver_profiles (a staff resolved_by matches no row -> contributes to nobody).
--   (e) solver_reputation_recount_from_disputes() — AFTER UPDATE on report_disputes
--       when status changes. Recomputes upheld_count + reverted_count for
--       disputed_solver_id (a dispute is always inserted `open`, so INSERT never
--       changes these). upheld_count is a highlighted SUBSET of resolved_count (the
--       report stays resuelto), NOT an additive tally.
--   (f) Backfill (in-migration, idempotent): historical disputed_solver_id for
--       `upheld` disputes (direct from reports.resolved_by) and best-effort for
--       `reverted` disputes (archaeology over report_status_history), then the three
--       counts for every existing solver_profiles row.
--
-- Convention notes (match 0017/0018):
--   * The three counts have NO client write path: solver_profiles already has only
--     solver_profiles_select_public (no client INSERT/UPDATE/DELETE policy); the
--     counts are maintained EXCLUSIVELY by the DEFINER triggers. No new grant — they
--     inherit the existing public SELECT. report_disputes' new column needs no grant
--     change (reads are admin-only, writes go through resolve_dispute / the file
--     policy).
--   * All three trigger functions are SECURITY DEFINER, search_path='', recompute
--     from scratch (not deltas), guard the write with IS DISTINCT FROM, and lock the
--     target row FOR NO KEY UPDATE — subsystem A's report_validations_recount
--     philosophy. They are trigger-only (never RPC-reachable) and REVOKE EXECUTE
--     from public, anon, authenticated, so they do NOT enter the advisor 0028/0029
--     baseline.
--   * This migration does NOT modify resolve_dispute, change_report_status,
--     refresh_report_visibility, or reports_in_view. The triggers REACT to their
--     effects.

-- ---------------------------------------------------------------------------
-- (a) report_disputes.disputed_solver_id — the challenged solver, stamped by the
-- BEFORE INSERT trigger below (never supplied by the client). Nullable: a staff
-- resolution (no solver_profiles row) or a null resolved_by stamps a value that
-- matches no solver_profiles row -> contributes to nobody's reputation (correct).
-- ---------------------------------------------------------------------------
alter table public.report_disputes
  add column disputed_solver_id uuid references public.profiles (id);

-- ---------------------------------------------------------------------------
-- (b) report_disputes_stamp_solver — BEFORE INSERT: stamp disputed_solver_id from
-- the report's current resolved_by, OVERWRITING any client-supplied value
-- unconditionally (the field is unforgeable; the client only ever inserts
-- report_id / reason / status='open', exactly as today). FOR SHARE pins the report
-- row against a concurrent resolve_dispute REVERT (see header). DEFINER +
-- search_path='' (hardened-DEFINER convention).
-- ---------------------------------------------------------------------------
create or replace function public.report_disputes_stamp_solver()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- FOR SHARE pins the report row: a concurrent REVERT cannot null resolved_by
  -- between the insert policy's status='resuelto' check and this read.
  new.disputed_solver_id := (
    select resolved_by from public.reports where id = new.report_id for share
  );
  return new;  -- BEFORE trigger: the modified row is what gets inserted
end;
$$;

revoke execute on function public.report_disputes_stamp_solver() from public, anon, authenticated;

create trigger report_disputes_stamp_solver_trg
  before insert on public.report_disputes
  for each row execute function public.report_disputes_stamp_solver();

-- ---------------------------------------------------------------------------
-- (c) solver_profiles reputation counts. Maintained by the recount triggers below;
-- no client write path (solver_profiles has only the public SELECT policy).
-- ---------------------------------------------------------------------------
alter table public.solver_profiles add column resolved_count int not null default 0;
alter table public.solver_profiles add column upheld_count   int not null default 0;
alter table public.solver_profiles add column reverted_count int not null default 0;

-- ---------------------------------------------------------------------------
-- (d) solver_reputation_recount_from_reports — AFTER INSERT/UPDATE/DELETE on
-- reports. For each affected solver (the distinct non-null values in
-- {OLD.resolved_by, NEW.resolved_by}), lock its solver_profiles row FOR NO KEY
-- UPDATE, recompute resolved_count from scratch (= resuelto AND is_visible reports
-- by that solver), and UPDATE only when it changed. A non-solver resolved_by simply
-- matches no solver_profiles row.
--
-- Terminates (no cycle): fires on reports, only UPDATEs solver_profiles; that UPDATE
-- fires no reports trigger, so the chain ends there.
-- ---------------------------------------------------------------------------
create or replace function public.solver_reputation_recount_from_reports()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid uuid;
  v_cnt int;
begin
  -- The set of solvers whose resolved_count may have changed: the distinct
  -- non-null values across OLD/NEW.resolved_by. On INSERT only NEW exists, on
  -- DELETE only OLD, on UPDATE both (and they may differ).
  for v_sid in
    select distinct sid
    from (values
      (case when tg_op <> 'DELETE' then new.resolved_by end),
      (case when tg_op <> 'INSERT' then old.resolved_by end)
    ) as s(sid)
    where sid is not null
  loop
    -- Lock the target solver row (serialize concurrent recomputes); only acts on
    -- ids that exist in solver_profiles.
    perform 1 from public.solver_profiles where id = v_sid for no key update;

    select count(*) into v_cnt
    from public.reports
    where resolved_by = v_sid
      and status = 'resuelto'
      and is_visible = true;

    update public.solver_profiles
       set resolved_count = v_cnt
     where id = v_sid
       and resolved_count is distinct from v_cnt;  -- only write when it changes
  end loop;

  return null;  -- AFTER trigger
end;
$$;

revoke execute on function public.solver_reputation_recount_from_reports() from public, anon, authenticated;

create trigger solver_reputation_recount_from_reports_trg
  after insert or update or delete on public.reports
  for each row execute function public.solver_reputation_recount_from_reports();

-- ---------------------------------------------------------------------------
-- (e) solver_reputation_recount_from_disputes — AFTER UPDATE on report_disputes
-- when status changes. Recompute upheld_count + reverted_count for the (immutable)
-- disputed_solver_id. Null-guarded (a staff/null-resolved dispute stamps null ->
-- nobody). A dispute is always inserted `open`, so INSERT never changes these counts
-- (this trigger is UPDATE-only).
-- ---------------------------------------------------------------------------
create or replace function public.solver_reputation_recount_from_disputes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid     uuid := new.disputed_solver_id;  -- disputed_solver_id never changes
  v_upheld  int;
  v_reverted int;
begin
  if old.status is distinct from new.status and v_sid is not null then
    -- Lock the target solver row (serialize concurrent recomputes); only acts on
    -- ids that exist in solver_profiles.
    perform 1 from public.solver_profiles where id = v_sid for no key update;

    select count(*) filter (where status = 'upheld'),
           count(*) filter (where status = 'reverted')
      into v_upheld, v_reverted
    from public.report_disputes
    where disputed_solver_id = v_sid;

    update public.solver_profiles
       set upheld_count   = v_upheld,
           reverted_count = v_reverted
     where id = v_sid
       and (upheld_count is distinct from v_upheld
            or reverted_count is distinct from v_reverted);  -- only write when it changes
  end if;

  return null;  -- AFTER trigger
end;
$$;

revoke execute on function public.solver_reputation_recount_from_disputes() from public, anon, authenticated;

create trigger solver_reputation_recount_from_disputes_trg
  after update on public.report_disputes
  for each row execute function public.solver_reputation_recount_from_disputes();

-- ---------------------------------------------------------------------------
-- (f) Backfill — in-migration, idempotent. IN ORDER: stamp historical
-- disputed_solver_id first (so the counts in step (c) see it), then initialize the
-- three counts for every solver_profiles row.
-- ---------------------------------------------------------------------------

-- (f.a) Historical `upheld` disputes: an uphold preserves attribution, so the
-- report is still resuelto with resolved_by = the challenged solver. Recover it
-- directly.
update public.report_disputes d
   set disputed_solver_id = r.resolved_by
  from public.reports r
 where r.id = d.report_id
   and d.status = 'upheld'
   and d.disputed_solver_id is null;

-- (f.b) Historical `reverted` disputes: a revert nulled reports.resolved_by, so the
-- challenged solver is recoverable only BEST-EFFORT from the latest `resuelto` event
-- in report_status_history before the dispute's reviewed_at (the changed_by of that
-- event is the solver who resolved). Production almost certainly has zero historical
-- disputes, so this path is near-certainly empty — documented as a known limitation,
-- not a silent assumption. The distinct-on subquery is safe under ambiguity (it
-- never errors; it deterministically picks the latest event).
update public.report_disputes d
   set disputed_solver_id = h.changed_by
  from (
    select distinct on (sh.report_id)
           sh.report_id, sh.changed_by, sh.created_at
    from public.report_status_history sh
    where sh.to_status = 'resuelto'
    order by sh.report_id, sh.created_at desc
  ) h
 where h.report_id = d.report_id
   and d.status = 'reverted'
   and d.disputed_solver_id is null
   -- a `reverted` dispute always has a non-null reviewed_at (resolve_dispute sets
   -- it), so no coalesce fallback is needed. NOTE: a resolve->revert->re-resolve
   -- chain can still mis-attribute to the LATER solver (distinct-on picks the most
   -- recent resuelto before reviewed_at) — best-effort, near-certainly empty in prod.
   and h.created_at <= d.reviewed_at;

-- (f.c) Initialize the three counts for EVERY solver_profiles row from current data
-- (after f.a/f.b have stamped historical disputed_solver_id). resolved_count =
-- resuelto AND is_visible reports by the solver; upheld/reverted = disputes of that
-- status attributed to the solver.
update public.solver_profiles sp
   set resolved_count = coalesce((
         select count(*) from public.reports r
         where r.resolved_by = sp.id
           and r.status = 'resuelto'
           and r.is_visible = true
       ), 0),
       upheld_count = coalesce((
         select count(*) from public.report_disputes d
         where d.disputed_solver_id = sp.id
           and d.status = 'upheld'
       ), 0),
       reverted_count = coalesce((
         select count(*) from public.report_disputes d
         where d.disputed_solver_id = sp.id
           and d.status = 'reverted'
       ), 0);
