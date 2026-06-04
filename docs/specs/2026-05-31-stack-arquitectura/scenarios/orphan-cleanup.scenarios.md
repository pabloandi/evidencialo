---
name: orphan-cleanup
created_by: orchestrator
created_at: 2026-06-03T00:00:00Z
step: 10
---

# Scenarios — orphan cleanup cron (GET /api/cron/cleanup)

A report is born `is_visible=false` before its media uploads. If the client never
finishes the upload, the row + partial Storage objects linger. A daily Vercel
Cron (`vercel.json`, already declared) calls `GET /api/cron/cleanup`, which
deletes reports that are still invisible AND older than 24h AND have media still
`pending` (abandoned uploads), together with their Storage objects. The 24h
threshold is INJECTABLE (a `now` arg) so tests use a fixed clock. The endpoint is
secured with `CRON_SECRET` (Vercel sends `Authorization: Bearer <CRON_SECRET>`).

Decision: only PENDING-media orphans are swept. A report whose media is `failed`
is kept (step09/E10: failures are recorded for panel review, not auto-deleted).

---

## SCEN-001: a >24h invisible report with pending media is deleted with its Storage objects (E9)
**Given**: a report `is_visible=false`, `created_at` 25h before the run clock, with a `pending` media row and a Storage object at `<report_id>/0.jpg`
**When**: the cleanup runs with `now` = that clock
**Then**: the report row is deleted, its `report_media` rows are gone (cascade), and the Storage objects under `<report_id>/` are removed
**Evidence**: integration — `SELECT count(*) FROM reports WHERE id=$r` = 0; `report_media` for `$r` = 0; `storage.from('report-media').list('<report_id>')` returns empty

## SCEN-002: a recent (1h) invisible orphan is NOT deleted
**Given**: a report `is_visible=false`, `created_at` 1h before the run clock, with pending media
**When**: the cleanup runs
**Then**: the report and its media are untouched
**Evidence**: integration — the report row still exists after the run

## SCEN-003: a visible report is never deleted, regardless of age
**Given**: a report `is_visible=true`, `created_at` 100h before the run clock
**When**: the cleanup runs
**Then**: the report is untouched
**Evidence**: integration — the report row still exists after the run

## SCEN-004: a >24h invisible report whose media is FAILED (not pending) is kept for review
**Given**: a report `is_visible=false`, 25h old, whose only media row is `processing_state='failed'` (no pending media)
**When**: the cleanup runs
**Then**: the report is NOT deleted (a failed report is retained for panel review, not swept as an abandoned upload)
**Evidence**: integration — the report row still exists after the run

## SCEN-005: the endpoint rejects an unauthenticated request
**Given**: `GET /api/cron/cleanup` WITHOUT the `Authorization: Bearer <CRON_SECRET>` header (or a wrong secret)
**When**: it reaches the handler
**Then**: the response is `401` and NO cleanup runs (the service is not invoked)
**Evidence**: HTTP 401; the cleanup service was never called (no deletions)
