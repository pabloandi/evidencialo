-- 0012_create_report_reporter.sql
-- Associate a report with its author when one is known (step14).
--
-- WHY: the citizen "mis reportes" view (`/mis-reportes`) lists a signed-in
-- user's OWN reports via the RLS policy `reports_select_own`
-- (`reporter_id = auth.uid()`, migration 0003). That policy can only ever match
-- rows that actually CARRY a `reporter_id` — but `create_report` (0006) always
-- inserted reports anonymously (no `reporter_id`), so "mis reportes" would be
-- permanently empty. This migration teaches the function to persist the author.
--
-- An account is OPTIONAL in evidencialo: a session-authenticated create passes
-- the user id (the POST route forwards the `getSessionRole` user); an anonymous
-- create passes null and stays anonymous exactly as before. So the only behavior
-- change is that authenticated reports now gain an owner — no existing row or
-- anonymous path is affected.
--
-- Adding a defaulted 7th parameter changes the function SIGNATURE, so this is a
-- DROP + CREATE (Postgres can't `create or replace` across a different argument
-- list). DROP discards the grants, so they are re-applied below to PRESERVE the
-- exact security posture of 0006 (service_role only — the sole caller is the
-- server-side admin client in the write path).

drop function public.create_report(uuid, double precision, double precision, text, text, jsonb);

create or replace function public.create_report(
  p_category_id     uuid,
  p_lng             double precision,
  p_lat             double precision,
  p_description     text,
  p_idempotency_key text,
  p_media           jsonb,
  p_reporter_id     uuid default null
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
  -- Best-effort author association: a signature-valid JWT can outlive its
  -- `auth.users` row (account deleted while a token is still cached on a device).
  -- Inserting that dangling id would FK-fail (23503) and 500 the WHOLE create on
  -- the shared write path — worse than losing the author link. Demote a dangling
  -- author to anonymous instead. NOTE: reporter_id is bound to the FIRST create
  -- for a given idempotency_key; an anonymous-first then authenticated replay of
  -- the same key stays anonymous (the ON CONFLICT replay returns the first row
  -- unchanged — idempotency's "identical replay" guarantee, not a bug).
  if p_reporter_id is not null
     and not exists (select 1 from auth.users u where u.id = p_reporter_id) then
    p_reporter_id := null;
  end if;

  -- Fresh insert, or no-op when the idempotency key already exists. The author
  -- (p_reporter_id) is null for anonymous creates and the session user otherwise.
  insert into public.reports (reporter_id, category_id, description, location, idempotency_key, is_visible)
  values (
    p_reporter_id,
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

-- Re-grant to MATCH 0006's posture (DROP loses grants): only the service-role
-- write path may call this. Lock everyone else out.
revoke execute on function public.create_report(uuid, double precision, double precision, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_report(uuid, double precision, double precision, text, text, jsonb, uuid) to service_role;
