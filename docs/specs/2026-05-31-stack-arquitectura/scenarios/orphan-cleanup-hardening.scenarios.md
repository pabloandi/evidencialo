---
name: orphan-cleanup-hardening
created_by: orchestrator
created_at: 2026-06-03T00:00:00Z
step: 10
note: additive scenarios from the step10 quality review (perf CRITICAL unbounded sweep / 1000-row cap + the zero-media coverage gap). Sibling holdout to orphan-cleanup.scenarios.md.
---

# Scenarios — orphan cleanup hardening (review findings)

The first cut swept with no LIMIT/order (PostgREST silently caps at 1000 rows and
a sequential per-orphan loop can exceed the function maxDuration) and discovered
candidates ONLY via pending media (so a zero-media orphan is never reclaimed).
Hold alongside SCEN-001..005.

---

## SCEN-H01: the sweep is bounded and oldest-first, so a backlog drains deterministically
**Given**: more invisible >24h pending-media orphans than the per-run batch limit (use an injectable small `batchLimit`, e.g. 2 orphans of different ages with `batchLimit=1`... or 3 with `batchLimit=2`)
**When**: the cleanup runs once
**Then**: it deletes at most `batchLimit` reports, and they are the OLDEST by `created_at` (ascending) — a second run deletes the next-oldest, so repeated runs make forward progress and never starve the tail
**Evidence**: integration/unit — with N > batchLimit seeded orphans of distinct ages, one run deletes exactly `batchLimit` of them and they are the oldest; the younger orphan(s) remain and are deleted on the next run

## SCEN-H02: an invisible >24h report with ZERO media is also swept
**Given**: a report `is_visible=false`, 25h old, with NO `report_media` rows at all (an abandoned creation with nothing ever uploaded)
**When**: the cleanup runs
**Then**: the report is deleted — a report with no media is an orphan too, reclaimed independently of the pending-media path (distinct from SCEN-004, where a `failed` media row means processing happened and the report is KEPT for review)
**Evidence**: integration — the zero-media old invisible report is gone from `reports` after the run
