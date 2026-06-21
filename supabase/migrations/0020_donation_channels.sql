-- 0020_donation_channels.sql
-- Subsystem D, chunk D1: donation channels — verified donation channels on a
-- solver's public profile. A verified solver self-manages a small typed set of
-- their OWN channels (nequi, daviplata, bancolombia, paypal); the platform never
-- custodies money — the donor pays the solver directly. This migration is purely
-- ADDITIVE: two tables, two RPCs, one storage bucket. It modifies no existing
-- table, RPC, trigger, view, or policy.
--
-- Adds:
--   (a) public.solver_donation_channels — public read; no client write path.
--       At most one channel per (solver_id, type); a typed allowlist + an
--       account_kind coupling CHECK (bancolombia => kind NOT NULL; every other
--       type => kind NULL) are the SINGLE source of truth for shape validation.
--   (b) public.solver_donation_channel_history — admin-read-only audit; every
--       set/delete records a snapshot (a donation channel is a money-redirect
--       target, so changes are forensically recorded).
--   (c) set_solver_donation_channel / delete_solver_donation_channel — owner-gated
--       SECURITY DEFINER RPCs. solver_id is ALWAYS auth.uid(), never a parameter,
--       so a solver can only ever write their own channels (SCEN-002). A
--       non-solver caller raises 42501. EXECUTE granted to authenticated, revoked
--       from public/anon by name (the Supabase default-EXECUTE-to-anon trap).
--   (d) the public-read `donation-qr` storage bucket (a QR exists to be scanned;
--       writes happen server-side under the service role, so no client storage
--       policy is needed).
--
-- Convention notes (match every prior migration):
--   * Tables are secured by RLS, NOT by revoking base DML grants.
--   * The RPCs are SECURITY DEFINER with search_path='' and every reference is
--     schema-qualified; the owner gate (the caller must own a solver_profiles
--     row) is the FIRST statement, so each function is its own security boundary.
--   * The bucket insert mirrors 0006's `on conflict (id) do nothing` idiom so a
--     `db reset` (and remote `db push`) reprovisions it without error.

-- ---------------------------------------------------------------------------
-- (a) solver_donation_channels — public read; writes only via the DEFINER RPCs.
-- ---------------------------------------------------------------------------
create table public.solver_donation_channels (
  id           uuid primary key default gen_random_uuid(),
  solver_id    uuid not null references public.solver_profiles (id) on delete cascade,
  type         text not null check (type in ('nequi', 'daviplata', 'bancolombia', 'paypal')),
  value        text not null check (length(value) between 1 and 256),  -- coarse DB-layer guard; precise per-type validation lives in Zod (D2)
  account_kind text check (account_kind in ('ahorros', 'corriente')),  -- bancolombia only
  qr_path      text,                                                    -- uploaded QR object path; NULL for paypal (auto-gen) or none
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (solver_id, type),  -- at most one channel per type (<= 4 per solver)
  -- account_kind coupling: bancolombia REQUIRES a kind; every other type FORBIDS one.
  check (
    (type = 'bancolombia' and account_kind is not null)
    or (type <> 'bancolombia' and account_kind is null)
  )
);

create index solver_donation_channels_solver_idx
  on public.solver_donation_channels (solver_id);

-- Channels are PUBLIC by design (they exist to be shown on the public profile).
grant select on public.solver_donation_channels to anon, authenticated;

alter table public.solver_donation_channels enable row level security;

-- Public SELECT; no INSERT/UPDATE/DELETE policy -> no client write path (writes
-- flow only through the owner-gated DEFINER RPCs below).
create policy solver_donation_channels_select_public on public.solver_donation_channels
  for select using (true);

-- ---------------------------------------------------------------------------
-- (b) solver_donation_channel_history — admin-read-only audit. No client write
--     path; every set/delete writes a row from inside the DEFINER RPCs.
-- ---------------------------------------------------------------------------
create table public.solver_donation_channel_history (
  id           uuid primary key default gen_random_uuid(),
  solver_id    uuid not null,                          -- NO FK to solver_profiles: the audit must survive a solver deletion (forensics)
  type         text not null,
  action       text not null check (action in ('set', 'delete')),
  old_value    jsonb,                                  -- prior channel row snapshot (NULL on first set)
  new_value    jsonb,                                  -- new channel row snapshot (NULL on delete)
  request_meta jsonb,                                  -- route-supplied IP/UA, kept in its OWN column so it can never collide with a snapshot key
  changed_by   uuid,
  changed_at   timestamptz not null default now()
);

create index solver_donation_channel_history_solver_idx
  on public.solver_donation_channel_history (solver_id);

alter table public.solver_donation_channel_history enable row level security;

-- Reads are admin-only (forensics); non-admins (anon + authenticated) see no rows.
create policy solver_donation_channel_history_select_admin on public.solver_donation_channel_history
  for select to anon, authenticated
  using (private.is_admin());

-- ---------------------------------------------------------------------------
-- (c) set_solver_donation_channel — owner-gated upsert + audit.
--     solver_id is ALWAYS auth.uid() (never a parameter). The table CHECKs are
--     the single source of truth for the allowlist + coupling; an invalid
--     type/coupling raises 23514 straight out of the DEFINER (SCEN-003/004).
-- ---------------------------------------------------------------------------
create or replace function public.set_solver_donation_channel(
  p_type         text,
  p_value        text,
  p_account_kind text  default null,
  p_qr_path      text  default null,
  p_request_meta jsonb default '{}'::jsonb
)
returns public.solver_donation_channels
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_solver uuid;
  v_old    public.solver_donation_channels;
  v_new    public.solver_donation_channels;
begin
  -- solver_id is ALWAYS the caller (auth.uid()), never client-supplied -> a
  -- solver can only ever write their own channels (the SCEN-002 boundary).
  v_solver := (select auth.uid());

  -- DB-layer authz: the caller must be a PUBLISHED solver (own a solver_profiles
  -- row). This is the precise gate — it is both the authz check AND the FK
  -- precondition for solver_id below, so a profiles.role='solver' that somehow
  -- lacks a solver_profiles row fails cleanly with 42501 instead of an opaque FK
  -- violation (23503). The security boundary does not rest on the HTTP route.
  if not exists (select 1 from public.solver_profiles where id = v_solver) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Defense in depth (the DB must not trust the route): bound the route-supplied
  -- audit meta so a direct authenticated caller cannot bloat the append-only history.
  if pg_column_size(p_request_meta) > 8192 then
    raise exception 'request_meta too large' using errcode = '22023';
  end if;

  -- Capture the prior row (if any) for the history old_value snapshot.
  select * into v_old
  from public.solver_donation_channels
  where solver_id = v_solver and type = p_type;

  -- Upsert on (solver_id, type) — re-setting a type updates the one row, never
  -- duplicates (UNIQUE(solver_id, type)). The table CHECKs enforce the allowlist
  -- + the account_kind coupling.
  insert into public.solver_donation_channels (solver_id, type, value, account_kind, qr_path)
  values (v_solver, p_type, p_value, p_account_kind, p_qr_path)
  on conflict (solver_id, type) do update
    set value        = excluded.value,
        account_kind = excluded.account_kind,
        qr_path      = excluded.qr_path,
        updated_at   = now()
  returning * into v_new;

  -- Audit: the prior + new row snapshots, plus the route-supplied request meta
  -- (IP / user-agent) in its OWN column, so a hijacked-channel claim is
  -- investigable beyond the account id alone — and the meta can never collide
  -- with a snapshot key.
  insert into public.solver_donation_channel_history
    (solver_id, type, action, old_value, new_value, request_meta, changed_by)
  values (
    v_solver,
    p_type,
    'set',
    case when v_old.id is not null then to_jsonb(v_old) else null end,
    to_jsonb(v_new),
    p_request_meta,
    (select auth.uid())
  );

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- (c) delete_solver_donation_channel — owner-gated delete + audit.
-- ---------------------------------------------------------------------------
create or replace function public.delete_solver_donation_channel(
  p_type         text,
  p_request_meta jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_solver uuid;
  v_old    public.solver_donation_channels;
begin
  v_solver := (select auth.uid());

  -- Same gate as set_…: the caller must own a solver_profiles row (authz + the
  -- FK precondition), so a role='solver' without the profile row fails 42501.
  if not exists (select 1 from public.solver_profiles where id = v_solver) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if pg_column_size(p_request_meta) > 8192 then
    raise exception 'request_meta too large' using errcode = '22023';
  end if;

  -- Capture the prior row for the history old_value snapshot, then delete it.
  select * into v_old
  from public.solver_donation_channels
  where solver_id = v_solver and type = p_type;

  delete from public.solver_donation_channels
  where solver_id = v_solver and type = p_type;

  insert into public.solver_donation_channel_history
    (solver_id, type, action, old_value, new_value, request_meta, changed_by)
  values (
    v_solver,
    p_type,
    'delete',
    case when v_old.id is not null then to_jsonb(v_old) else null end,
    null,
    p_request_meta,
    (select auth.uid())
  );
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon by default; revoke it
-- and grant only to authenticated (the solver_profiles-row gate is enforced inside).
-- anon must be revoked BY NAME (revoke from public is not enough — linter 0028).
revoke execute on function public.set_solver_donation_channel(text, text, text, text, jsonb) from public, anon;
grant execute on function public.set_solver_donation_channel(text, text, text, text, jsonb) to authenticated;

revoke execute on function public.delete_solver_donation_channel(text, jsonb) from public, anon;
grant execute on function public.delete_solver_donation_channel(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- (d) donation-qr storage bucket — PUBLIC read (a QR exists to be scanned).
--     Created idempotently so `db reset` / remote `db push` reprovision it.
--     Writes happen server-side under the service role (the upload route), so no
--     client storage policy is required.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('donation-qr', 'donation-qr', true)
on conflict (id) do nothing;
