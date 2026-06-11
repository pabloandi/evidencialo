-- Subsystem B, chunk B3.1 — disputes (solver-resolution.scenarios.md SCEN-007).
--
-- A verified solver turns a complaint into a `resuelto` report with public proof
-- and public attribution ("Resuelto por @handle"). The original reporter is
-- usually anonymous, so the trust backstop is NOT the reporter — it is a public
-- DISPUTE path: anyone may flag a false/abusive resolution, and an ADMIN reviews
-- it and either UPHOLDS it (the resolution stands) or REVERTS it (the report goes
-- back to `en_proceso` and the public resolved-attribution is stripped).
--
-- This migration adds:
--   (a) public.report_disputes — one row per filed dispute. At most ONE `open`
--       dispute may exist per report (a partial unique index coalesces spam).
--   (b) RLS — anyone (anon + authenticated) may FILE an `open` dispute against a
--       `resuelto` report (the only explicit client-write allowance on this
--       table); reads are ADMIN-ONLY; there is no client UPDATE/DELETE policy, so
--       every state transition flows through the DEFINER RPC below.
--   (c) public.resolve_dispute(p_dispute_id, p_action) — admin-only DEFINER RPC.
--       On REVERT it clears resolved_at/resolved_by DIRECTLY here (NOT via
--       change_report_status, which deliberately never clears resolved_at — see
--       0011/0015) and writes an audit row. `claimed_by`/`claimed_at` are
--       intentionally PRESERVED: a reverted report legitimately remains "claimed"
--       by that solver, now back in progress (SCEN-007 clears only resolved_*).
--
-- Convention notes (match every prior migration):
--   * The table is secured by RLS, NOT by revoking base DML grants.
--   * The RPC is SECURITY DEFINER with search_path='' and is REVOKEd from
--     public + anon then granted to authenticated BY NAME — the Supabase
--     default-EXECUTE-to-anon trap (the admin gate lives inside the function).

-- ---------------------------------------------------------------------------
-- (a) Table
-- ---------------------------------------------------------------------------
create table public.report_disputes (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.reports (id) on delete cascade,
  reason      text,                                              -- free-text; trimmed/empty -> NULL at the API layer
  created_by  uuid references auth.users (id) on delete set null, -- null = anonymous disputer (mirrors reports.reporter_id)
  status      text not null default 'open'
              check (status in ('open', 'upheld', 'reverted')),
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Coalesce dispute spam: AT MOST ONE `open` dispute per report. A second open
-- insert on the same report raises 23505 (the API maps it to a friendly "ya hay
-- una disputa abierta"). Resolved disputes (upheld/reverted) do not block a new
-- one, so a re-resolved report can be disputed again.
create unique index report_disputes_one_open
  on public.report_disputes (report_id)
  where status = 'open';

create index report_disputes_report_idx
  on public.report_disputes (report_id);

-- ---------------------------------------------------------------------------
-- (b) RLS — file open to anyone (constrained); read admin-only; no client
--     UPDATE/DELETE (resolution goes through resolve_dispute()).
-- ---------------------------------------------------------------------------
alter table public.report_disputes enable row level security;

-- The ONE explicit client-write allowance on this table: anon + authenticated
-- may INSERT an `open` dispute, attributed only to themselves (or anonymous),
-- and only against a `resuelto` report. They cannot forge `upheld`/`reverted`
-- (status must be 'open'), cannot impersonate another disputer (created_by must
-- be self or null), and cannot dispute a non-resolved report.
create policy report_disputes_insert_open on public.report_disputes
  for insert to anon, authenticated
  with check (
    status = 'open'
    and (created_by is null or created_by = (select auth.uid()))
    and exists (
      select 1 from public.reports r
      where r.id = report_id and r.status = 'resuelto'
    )
  );

-- Reads are admin-only (the /panel dispute review). Non-admins (including
-- non-admin staff) see no dispute rows.
create policy report_disputes_select_admin on public.report_disputes
  for select to anon, authenticated
  using (private.is_admin());

-- ---------------------------------------------------------------------------
-- (c) resolve_dispute — admin-only review action (uphold | revert).
-- ---------------------------------------------------------------------------
create or replace function public.resolve_dispute(
  p_dispute_id uuid,
  p_action     text
)
returns table(dispute_id uuid, dispute_status text, report_status public.report_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id      uuid;
  v_dispute_status text;
  v_from           public.report_status;
  v_new_dispute    text;
  v_new_report     public.report_status;
begin
  -- DB-layer authz: ONLY an admin may review disputes (design §Authz —
  -- private.is_admin() gates grant_solver and resolve_dispute).
  if not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_action not in ('uphold', 'revert') then
    raise exception 'invalid action' using errcode = '22023';
  end if;

  -- Lock the dispute; capture its report + current status.
  select d.report_id, d.status
    into v_report_id, v_dispute_status
  from public.report_disputes d
  where d.id = p_dispute_id
  for update;

  if not found then
    raise exception 'dispute not found' using errcode = 'P0002';
  end if;

  -- Only an OPEN dispute can be reviewed — no double-processing.
  if v_dispute_status <> 'open' then
    raise exception 'dispute already resolved' using errcode = 'P0001';
  end if;

  if p_action = 'uphold' then
    -- The resolution stands: the report is unchanged; only the dispute closes.
    update public.report_disputes
    set status = 'upheld', reviewed_by = (select auth.uid()), reviewed_at = now()
    where id = p_dispute_id;
    v_new_dispute := 'upheld';

    select r.status into v_new_report from public.reports r where r.id = v_report_id;
  else
    -- REVERT: lock the report, capture from_status for the audit, then strip the
    -- resolved-attribution DIRECTLY (change_report_status never clears
    -- resolved_at, so the revert path must null it here). claimed_by/claimed_at
    -- are PRESERVED (SCEN-007 clears only resolved_*).
    select r.status into v_from from public.reports r where r.id = v_report_id for update;

    update public.reports
    set status      = 'en_proceso',
        resolved_at = null,
        resolved_by = null,
        updated_at  = now()
    where id = v_report_id;

    -- Audit row — same shape as change_report_status v2's insert.
    insert into public.report_status_history (report_id, from_status, to_status, changed_by, note)
    values (v_report_id, v_from, 'en_proceso', (select auth.uid()), 'dispute revert');

    update public.report_disputes
    set status = 'reverted', reviewed_by = (select auth.uid()), reviewed_at = now()
    where id = p_dispute_id;
    v_new_dispute := 'reverted';
    v_new_report  := 'en_proceso';
  end if;

  return query select p_dispute_id, v_new_dispute, v_new_report;
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon by default; revoke it
-- and grant only to authenticated (the admin gate is enforced inside).
revoke execute on function public.resolve_dispute(uuid, text) from public, anon;
grant execute on function public.resolve_dispute(uuid, text) to authenticated;
