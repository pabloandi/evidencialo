---
name: visibility-trigger
created_by: orchestrator
created_at: 2026-06-03T00:00:00Z
step: 08
---

# Scenarios — visibility trigger (migration 0007)

The DB trigger on `report_media.processing_state` is the SINGLE source of truth
for `reports.is_visible`. It closes the race between the image path (`/api/media`)
and the video path (Edge Function, later) — neither decides visibility; the
trigger does. Decision: it RECOMPUTES on every change —
`is_visible = NOT EXISTS(any media for this report in 'pending' or 'failed')` —
so visibility is correct in both directions (a late `failed` un-publishes a
report; design §6: "un reporte con media failed nunca se publica"). The trigger
only writes when the value actually changes (no needless updates / recursion).
A report is born `is_visible = false` (step03 default) and needs ≥1 media
(step05), so a report with zero media rows is never touched and stays invisible.

Evidence is observed via pgTAP against a fresh local DB (`supabase test db`):
seed a report + media as `postgres` (bypassing RLS), update `processing_state`,
assert `reports.is_visible`.

---

## SCEN-001: all media processed → report becomes visible (E1 closure)
**Given**: a report with two `report_media` rows, both `pending`
**When**: both rows are updated to `processing_state = 'processed'`
**Then**: after the final update, the report's `is_visible` is `true`
**Evidence**: pgTAP — `SELECT is_visible FROM reports WHERE id = $r` is `true` once no media remains pending/failed

## SCEN-002: any pending media keeps the report invisible (E2)
**Given**: a report with two media rows, one `processed` and one `pending`
**When**: the trigger evaluates the report (on the processed update)
**Then**: the report's `is_visible` remains `false`
**Evidence**: pgTAP — `is_visible` is `false` while a `pending` row exists

## SCEN-003: any failed media keeps the report invisible (E10, part)
**Given**: a report with two media rows, one `processed` and one `failed`
**When**: the trigger evaluates the report
**Then**: the report's `is_visible` remains `false`
**Evidence**: pgTAP — `is_visible` is `false` while a `failed` row exists

## SCEN-004: processing the last pending media flips visibility false→true
**Given**: a report with a single `pending` media row and `is_visible = false`
**When**: that row is updated to `processed`
**Then**: `is_visible` transitions to `true`
**Evidence**: pgTAP — `is_visible` is `false` before the update and `true` immediately after

## SCEN-005: a late failure un-publishes a previously visible report
**Given**: a report whose media is all `processed` and `is_visible = true`
**When**: one of its media rows is updated `processed → failed`
**Then**: `is_visible` reverts to `false`
**Evidence**: pgTAP — `is_visible` is `true` before, `false` after the failure (a failed report is never published)

## SCEN-006: a report's visibility depends only on its OWN media
**Given**: two distinct reports A (one `pending` media) and B (one `pending` media)
**When**: B's media is updated to `processed`
**Then**: B becomes `is_visible = true` and A stays `is_visible = false` (untouched)
**Evidence**: pgTAP — after B's update, `is_visible` is `true` for B and `false` for A
