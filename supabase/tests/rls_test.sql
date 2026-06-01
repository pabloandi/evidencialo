-- RLS policy tests (pgTAP). Run with: supabase test db
-- Covers observable scenarios E2 (not visible until processed — read side),
-- E3 (only staff change status), E5 (citizen sees own), plus the full §4 list:
-- report_status_history staff-only, report_media tied to parent visibility.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

-- pgTAP assertions run under anon/authenticated below; make sure those roles
-- may call them (test database only; rolled back at the end).
grant execute on all functions in schema extensions to anon, authenticated;

select plan(9);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a@test.local'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'b@test.local'),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 's@test.local');

-- handle_new_user created profiles (role citizen). Promote the third to staff.
update public.profiles set role = 'staff' where id = '33333333-3333-3333-3333-333333333333';

insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', c.id, 'nuevo',
       'SRID=4326;POINT(-74.08 4.61)'::extensions.geography, true
from public.categories c where c.slug = 'bache';

insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', c.id, 'nuevo',
       'SRID=4326;POINT(-74.07 4.60)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

insert into public.reports (id, reporter_id, category_id, status, location, is_visible)
select 'cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', c.id, 'nuevo',
       'SRID=4326;POINT(-74.06 4.59)'::extensions.geography, false
from public.categories c where c.slug = 'bache';

insert into public.report_media (report_id, storage_path, type)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'reports/b/img.jpg', 'image');

insert into public.report_status_history (report_id, to_status, changed_by)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nuevo', '33333333-3333-3333-3333-333333333333');

-- ---------------------------------------------------------------------------
-- E2: anonymous sees only visible reports
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '', true);
select is((select count(*) from public.reports)::int, 1,
  'E2: anon sees only is_visible reports');
reset role;

-- ---------------------------------------------------------------------------
-- E5: citizen A sees visible + own hidden, never another citizen''s hidden
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);
select is((select count(*) from public.reports)::int, 2,
  'E5: citizen A sees visible + own hidden report');
select is((select count(*) from public.reports where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc')::int, 0,
  'E5: citizen A cannot see another citizen''s hidden report');
-- E3 (negative): citizen update is filtered by RLS (affects 0 rows)
update public.reports set status = 'resuelto' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
reset role;
select is((select status from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'nuevo'::public.report_status, 'E3: citizen status update denied by RLS');

-- citizen cannot read status history
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);
select is((select count(*) from public.report_status_history)::int, 0,
  '§4: citizen cannot read report_status_history');
-- citizen cannot read media of another report that is hidden (own hidden media IS visible)
select is((select count(*) from public.report_media)::int, 1,
  '§4: citizen sees media of own report; report_media read tied to parent');
reset role;

-- ---------------------------------------------------------------------------
-- E3 (positive) + staff visibility
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
select is((select count(*) from public.reports)::int, 3,
  'staff sees all reports');
select is((select count(*) from public.report_status_history)::int, 1,
  '§4: staff can read report_status_history');
update public.reports set status = 'en_proceso' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
reset role;
select is((select status from public.reports where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'en_proceso'::public.report_status, 'E3: staff status update applied');

select * from finish();
rollback;
