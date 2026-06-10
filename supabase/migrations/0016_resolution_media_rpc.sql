-- 0016_resolution_media_rpc.sql
-- Subsystem B, chunk B2.2a: attach resolution PROOF media to an EXISTING report.
--
-- The universal proof gate in 0015 (`change_report_status` → resuelto) refuses
-- to resolve a report without >=1 processed `kind='resolution'` media. But
-- `create_report` (0006) only mints media at CREATION time — there was no path
-- to add proof to an already-existing report. This migration opens that path.
--
-- WHY a dedicated DEFINER RPC (and not a direct insert from the service):
--   * Authz lives in the DB, not the HTTP route. The proof gate is UNIVERSAL —
--     staff/admin AND verified solvers can resolve, so BOTH must be able to
--     supply proof (gating this solver-only would lock staff out of resolving).
--     A citizen/anon must never attach proof. The gate is the FIRST statement,
--     so the function is its own security boundary (pre-empts advisor 0029).
--   * Attribution (`uploaded_by`) is taken from `auth.uid()` INSIDE the body,
--     never a client arg — a caller can never forge who supplied the proof
--     (mirrors `create_report`/`grant_solver`/`change_report_status` v2).
--   * Storage paths are namespaced under `<report_id>/resolution/<suffix>` so
--     proof objects can NEVER collide with the report's complaint media
--     (`<report_id>/<suffix>` from 0006). The service mints the per-item suffix
--     (`<index>.<ext>`) exactly like `create_report`, and this RPC stores it
--     verbatim and echoes it back so the persisted path equals the signed path.
--   * Rows are born `processing_state='pending'` (the column default). The
--     existing, kind-AGNOSTIC processors flip them to 'processed': /api/media
--     for images, the video sanitizer for video. The visibility trigger v2
--     (0015) ignores `kind='resolution'`, so attaching a pending proof NEVER
--     (un)publishes the report.
--
-- DEFINER hardening per Supabase guidance: `search_path=''` (every reference
-- fully qualified), EXECUTE revoked from public/anon by name (Supabase grants it
-- to anon by default → linter 0028 would otherwise fire), granted to
-- `authenticated` only. The internal is_staff/is_solver gate further restricts
-- the effect.
create or replace function public.attach_resolution_media(
  p_report_id uuid,
  p_media     jsonb   -- [{storage_path text, type text, duration_s int}]
)
returns jsonb         -- { media: [{id, type, storage_path}] }
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media jsonb;
begin
  -- DB-layer authz: only staff/admin OR a verified solver may attach proof
  -- (both can resolve, so both must be able to supply proof). The security
  -- boundary does not rest on the HTTP route.
  if not (private.is_staff() or private.is_solver()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The report must exist (route maps to 404). Proof for a non-existent report
  -- is a clean not-found, never an orphan media row.
  if not exists (select 1 from public.reports where id = p_report_id) then
    raise exception 'report not found' using errcode = 'P0002';
  end if;

  -- Insert resolution media. storage_path is namespaced under
  -- `<report_id>/resolution/<suffix>` so proof objects NEVER collide with the
  -- report's complaint media (`<report_id>/<suffix>`). kind='resolution',
  -- uploaded_by = auth.uid() (attribution, never a client arg). Born 'pending';
  -- /api/media (image) or sanitize-video (video) flips it to 'processed'. The
  -- visibility trigger v2 ignores kind='resolution', so this never (un)publishes.
  with ins as (
    insert into public.report_media (report_id, storage_path, type, duration_s, kind, uploaded_by)
    select
      p_report_id,
      p_report_id::text || '/resolution/' || m.storage_path,
      m.type::public.media_type,
      m.duration_s,
      'resolution',
      (select auth.uid())
    from rows from (
      jsonb_to_recordset(p_media) as (storage_path text, type text, duration_s int)
    ) with ordinality as m(storage_path, type, duration_s, ord)
    order by m.ord
    returning id, type, storage_path, created_at
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('id', id, 'type', type, 'storage_path', storage_path) order by created_at, id),
    '[]'::jsonb
  ) into v_media from ins;

  return jsonb_build_object('media', v_media);
end;
$$;

-- Only authenticated callers may invoke it; anon never can. The internal
-- is_staff/is_solver gate further restricts the effect. Supabase's default
-- privileges grant EXECUTE on public functions to anon, so anon is revoked BY
-- NAME (otherwise linter 0028 fires).
revoke execute on function public.attach_resolution_media(uuid, jsonb) from public, anon;
grant  execute on function public.attach_resolution_media(uuid, jsonb) to authenticated;
