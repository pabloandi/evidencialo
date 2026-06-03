-- 0006_report_idempotency_and_storage.sql
-- Write-path foundations for report creation (step05).
--
-- Idempotency: a network retry must never duplicate a report. The client sends
-- an `Idempotency-Key` header; the service stores it on the row. A PARTIAL
-- unique index (only WHERE the key is not null) makes any non-null key unique
-- across the table while still allowing many NULL keys (anonymous reports with
-- no key). This pushes idempotency enforcement into the database, so two
-- concurrent retries race-safely collapse into one row (the loser gets a 23505
-- unique-violation the service catches and turns into a 200 replay).
--
-- Storage: media is uploaded by the client straight to a PRIVATE bucket via a
-- signed upload URL the service mints. The bucket is created idempotently so a
-- `db reset` (and remote `db push`) reprovisions it without error.

alter table public.reports
  add column idempotency_key text;

create unique index reports_idempotency_key_uidx
  on public.reports (idempotency_key)
  where idempotency_key is not null;

insert into storage.buckets (id, name, public)
values ('report-media', 'report-media', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Transactional report+media creation
-- ---------------------------------------------------------------------------
-- One function, one transaction: insert the report (invisible) and ALL its
-- media rows atomically, or nothing at all. This closes three gaps the first
-- cut left open:
--   * orphan reports — a report could persist while a later media insert failed
--     (now both roll back together: SCEN-012 atomicity);
--   * poisoned replay — a half-created report could be returned on retry;
--   * 23505-replay race — two concurrent retries both inserting the same key.
-- Idempotency is handled in-statement with `on conflict ... do nothing`: the
-- loser of the race gets no row back and falls through to the replay branch,
-- returning the winner's report. No exception handling, no second round trip.
--
-- Location is built from numeric args with PostGIS (schema-qualified to
-- `extensions`, where the extension lives) — never string interpolation, so a
-- crafted lng/lat can't smuggle SQL or a wrong SRID.
--
-- SECURITY DEFINER with search_path locked to '' (every reference fully
-- qualified) per Supabase hardening guidance; executable only by service_role
-- (the role the service-role key authenticates as), the sole caller in the
-- server-side write path.
create or replace function public.create_report(
  p_category_id     uuid,
  p_lng             double precision,
  p_lat             double precision,
  p_description     text,
  p_idempotency_key text,
  p_media           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_id uuid;
  v_media     jsonb;
begin
  -- Fresh insert, or no-op when the idempotency key already exists.
  insert into public.reports (category_id, description, location, idempotency_key, is_visible)
  values (
    p_category_id,
    p_description,
    extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
    p_idempotency_key,
    false
  )
  on conflict (idempotency_key) where idempotency_key is not null
  do nothing
  returning id into v_report_id;

  if v_report_id is not null then
    -- Fresh report: insert every media row in ONE statement, preserving the
    -- client's order via WITH ORDINALITY. The persisted storage_path is the
    -- report id prefixed onto the client's per-item suffix (e.g. `0.jpg`), so
    -- objects are namespaced per report and never collide across reports.
    insert into public.report_media (report_id, storage_path, type, duration_s)
    select
      v_report_id,
      v_report_id::text || '/' || m.storage_path,
      m.type::public.media_type,
      m.duration_s
    from rows from (
      jsonb_to_recordset(p_media)
        as (storage_path text, type text, duration_s int)
    ) with ordinality as m(storage_path, type, duration_s, ord)
    order by m.ord;

    select coalesce(
      jsonb_agg(
        jsonb_build_object('id', rm.id, 'type', rm.type, 'storage_path', rm.storage_path)
        order by m.ord
      ),
      '[]'::jsonb
    )
    into v_media
    from public.report_media rm
    join rows from (
      jsonb_to_recordset(p_media)
        as (storage_path text, type text, duration_s int)
    ) with ordinality as m(storage_path, type, duration_s, ord)
      on rm.storage_path = v_report_id::text || '/' || m.storage_path
    where rm.report_id = v_report_id;

    return jsonb_build_object(
      'report_id', v_report_id,
      'idempotent', false,
      'media', v_media
    );
  end if;

  -- Conflict: the key already maps to a report. Return it unchanged (replay).
  select id into v_report_id
  from public.reports
  where idempotency_key = p_idempotency_key;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', rm.id, 'type', rm.type, 'storage_path', rm.storage_path)
      order by rm.created_at, rm.id
    ),
    '[]'::jsonb
  )
  into v_media
  from public.report_media rm
  where rm.report_id = v_report_id;

  return jsonb_build_object(
    'report_id', v_report_id,
    'idempotent', true,
    'media', v_media
  );
end;
$$;

-- Only the service-role write path may call this. Lock everyone else out.
revoke execute on function public.create_report(uuid, double precision, double precision, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_report(uuid, double precision, double precision, text, text, jsonb) to service_role;
