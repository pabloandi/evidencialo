-- Visibility trigger tests (pgTAP). Run with: supabase test db
-- Encodes the holdout contract (visibility-trigger.scenarios.md, SCEN-001..006):
-- the report_media trigger is the SINGLE source of truth for reports.is_visible.
-- is_visible = report has >=1 media AND no media is 'pending'/'failed'; the
-- trigger recomputes on every media change, in both directions, so a late
-- 'failed' un-publishes a previously visible report (design §6).
--
-- Seeded as superuser (bypasses RLS). Fixed UUIDs, seeded category 'bache',
-- valid PostGIS locations. Reports are born is_visible=false (step03 default);
-- the trigger flips them.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path = extensions, public;

select plan(13);

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser; bypasses RLS). reporter_id left null (anonymous).
-- One report per scenario so cases never interfere.
-- ---------------------------------------------------------------------------
insert into public.reports (id, category_id, location, is_visible)
select r.id, c.id, r.loc, false
from public.categories c
cross join (values
  ('10000000-0000-0000-0000-000000000001'::uuid, 'SRID=4326;POINT(-74.08 4.61)'::extensions.geography), -- SCEN-001
  ('10000000-0000-0000-0000-000000000002'::uuid, 'SRID=4326;POINT(-74.08 4.62)'::extensions.geography), -- SCEN-002
  ('10000000-0000-0000-0000-000000000003'::uuid, 'SRID=4326;POINT(-74.08 4.63)'::extensions.geography), -- SCEN-003
  ('10000000-0000-0000-0000-000000000004'::uuid, 'SRID=4326;POINT(-74.08 4.64)'::extensions.geography), -- SCEN-004
  ('10000000-0000-0000-0000-000000000005'::uuid, 'SRID=4326;POINT(-74.08 4.65)'::extensions.geography), -- SCEN-005
  ('1000000a-0000-0000-0000-00000000000a'::uuid, 'SRID=4326;POINT(-74.08 4.66)'::extensions.geography), -- SCEN-006 A
  ('1000000b-0000-0000-0000-00000000000b'::uuid, 'SRID=4326;POINT(-74.08 4.67)'::extensions.geography), -- SCEN-006 B
  ('10000000-0000-0000-0000-000000000072'::uuid, 'SRID=4326;POINT(-74.08 4.68)'::extensions.geography), -- SCEN-H02
  ('10000000-0000-0000-0000-000000000073'::uuid, 'SRID=4326;POINT(-74.08 4.69)'::extensions.geography)  -- SCEN-H03
) as r(id, loc)
where c.slug = 'bache';

-- ===========================================================================
-- SCEN-001: all media processed -> report becomes visible (E1 closure)
-- Two pending media; update both to processed; expect is_visible = true.
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('20000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '1/a.jpg', 'image', 'pending'),
  ('20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', '1/b.jpg', 'image', 'pending');

update public.report_media set processing_state = 'processed'
  where id = '20000000-0000-0000-0000-000000000011';
update public.report_media set processing_state = 'processed'
  where id = '20000000-0000-0000-0000-000000000012';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000001'),
  true,
  'SCEN-001: both media processed -> report is_visible = true');

-- ===========================================================================
-- SCEN-002: any pending media keeps the report invisible (E2)
-- One processed + one pending; expect is_visible = false.
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('20000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000002', '2/a.jpg', 'image', 'pending'),
  ('20000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000002', '2/b.jpg', 'image', 'pending');

update public.report_media set processing_state = 'processed'
  where id = '20000000-0000-0000-0000-000000000021';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000002'),
  false,
  'SCEN-002: one media still pending -> report is_visible = false');

-- ===========================================================================
-- SCEN-003: any failed media keeps the report invisible (E10, part)
-- One processed + one failed; expect is_visible = false.
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('20000000-0000-0000-0000-000000000031', '10000000-0000-0000-0000-000000000003', '3/a.jpg', 'image', 'pending'),
  ('20000000-0000-0000-0000-000000000032', '10000000-0000-0000-0000-000000000003', '3/b.jpg', 'image', 'pending');

update public.report_media set processing_state = 'processed'
  where id = '20000000-0000-0000-0000-000000000031';
update public.report_media set processing_state = 'failed'
  where id = '20000000-0000-0000-0000-000000000032';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000003'),
  false,
  'SCEN-003: one media failed -> report is_visible = false');

-- ===========================================================================
-- SCEN-004: processing the last pending media flips visibility false -> true
-- Single pending media: assert false; update to processed: assert true.
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('20000000-0000-0000-0000-000000000041', '10000000-0000-0000-0000-000000000004', '4/a.jpg', 'image', 'pending');

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000004'),
  false,
  'SCEN-004: single pending media -> report is_visible = false (before)');

update public.report_media set processing_state = 'processed'
  where id = '20000000-0000-0000-0000-000000000041';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000004'),
  true,
  'SCEN-004: last pending media processed -> report is_visible = true (after)');

-- ===========================================================================
-- SCEN-005: a late failure un-publishes a previously visible report
-- Two processed media (visible=true); flip one processed -> failed; expect false.
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('20000000-0000-0000-0000-000000000051', '10000000-0000-0000-0000-000000000005', '5/a.jpg', 'image', 'pending'),
  ('20000000-0000-0000-0000-000000000052', '10000000-0000-0000-0000-000000000005', '5/b.jpg', 'image', 'pending');

update public.report_media set processing_state = 'processed'
  where report_id = '10000000-0000-0000-0000-000000000005';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000005'),
  true,
  'SCEN-005: all media processed -> report is_visible = true (before failure)');

update public.report_media set processing_state = 'failed'
  where id = '20000000-0000-0000-0000-000000000052';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000005'),
  false,
  'SCEN-005: late failure -> report is_visible reverts to false');

-- ===========================================================================
-- SCEN-006: a report's visibility depends only on its OWN media (isolation)
-- A and B each have one pending media. Process B's media only.
-- Expect B visible = true AND A visible = false (untouched).
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('2000000a-0000-0000-0000-00000000000a', '1000000a-0000-0000-0000-00000000000a', 'a/a.jpg', 'image', 'pending'),
  ('2000000b-0000-0000-0000-00000000000b', '1000000b-0000-0000-0000-00000000000b', 'b/b.jpg', 'image', 'pending');

update public.report_media set processing_state = 'processed'
  where id = '2000000b-0000-0000-0000-00000000000b';

select is(
  (select is_visible from public.reports where id = '1000000b-0000-0000-0000-00000000000b'),
  true,
  'SCEN-006: B''s media processed -> B is_visible = true');

select is(
  (select is_visible from public.reports where id = '1000000a-0000-0000-0000-00000000000a'),
  false,
  'SCEN-006: A untouched -> A is_visible = false (isolation)');

-- ===========================================================================
-- SCEN-H02: deleting a report cascades its media without error (no recursion)
-- The AFTER DELETE trigger fires per child row; the parent row is gone, so the
-- guarded update touches nothing. Assert the delete lives and no media remains.
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('20000000-0000-0000-0000-000000000721', '10000000-0000-0000-0000-000000000072', '72/a.jpg', 'image', 'processed'),
  ('20000000-0000-0000-0000-000000000722', '10000000-0000-0000-0000-000000000072', '72/b.jpg', 'image', 'pending');

select lives_ok(
  $$ delete from public.reports where id = '10000000-0000-0000-0000-000000000072' $$,
  'SCEN-H02: parent delete cascades without error');

select is(
  (select count(*)::int from public.report_media where report_id = '10000000-0000-0000-0000-000000000072'),
  0,
  'SCEN-H02: media cascade-deleted');

-- ===========================================================================
-- SCEN-H03: a report re-publishes after a failure is resolved
-- All processed (visible) -> one media fails (invisible) -> re-processed
-- (visible again). The un-publish is not permanent.
-- ===========================================================================
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('20000000-0000-0000-0000-000000000731', '10000000-0000-0000-0000-000000000073', '73/a.jpg', 'image', 'pending'),
  ('20000000-0000-0000-0000-000000000732', '10000000-0000-0000-0000-000000000073', '73/b.jpg', 'image', 'pending');

update public.report_media set processing_state = 'processed'
  where report_id = '10000000-0000-0000-0000-000000000073';

update public.report_media set processing_state = 'failed'
  where id = '20000000-0000-0000-0000-000000000732';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000073'),
  false,
  'SCEN-H03: media failed -> report is_visible = false');

update public.report_media set processing_state = 'processed'
  where id = '20000000-0000-0000-0000-000000000732';

select is(
  (select is_visible from public.reports where id = '10000000-0000-0000-0000-000000000073'),
  true,
  'SCEN-H03: failure resolved -> report re-publishes is_visible = true');

select * from finish();
rollback;
