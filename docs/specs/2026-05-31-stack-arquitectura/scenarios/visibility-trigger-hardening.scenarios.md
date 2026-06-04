---
name: visibility-trigger-hardening
created_by: orchestrator
created_at: 2026-06-03T00:00:00Z
step: 08
note: additive scenarios from the step08 quality review (edge-case CRITICAL concurrency race + untested cascade/re-publish paths). Sibling holdout to visibility-trigger.scenarios.md.
---

# Scenarios — visibility trigger hardening (review findings)

The recompute design closes the publish-too-early race but, under READ COMMITTED,
opens a publish-NEVER race: two concurrent writers flipping the last two
`pending` media to `processed` each fail to see the other's uncommitted row and
both compute `is_visible = false`, stranding the report invisible. The fix is a
`for no key update` row lock on the parent report inside the trigger so
concurrent recomputes for the same report serialize. These scenarios must hold
alongside SCEN-001..006.

---

## SCEN-H01: two concurrent writers completing the last media still publish the report
**Given**: a report with two `pending` media rows (A and B), `is_visible = false`, and two concurrent DB transactions — Tx1 updates A→'processed', Tx2 updates B→'processed' — whose lifetimes overlap
**When**: both transactions commit
**Then**: the report ends `is_visible = true` (it is NOT stranded invisible); the trigger serializes the recompute via a `for no key update` lock on the report so the later transaction re-reads the committed sibling
**Evidence**: a two-connection test (two psql sessions with overlapping `BEGIN`s, the second update blocking until the first commits) leaves `SELECT is_visible FROM reports WHERE id=$r` = `true`. If a deterministic concurrent harness is infeasible, the evidence is the presence of the `for no key update` lock in the trigger plus a documented serialization argument.

## SCEN-H02: deleting a report cascades its media without error
**Given**: a report with two media rows
**When**: `DELETE FROM reports WHERE id = $r` runs (cascading to `report_media`, which fires the AFTER DELETE visibility trigger per child row)
**Then**: the delete succeeds with no error or recursion; no `report_media` rows remain for that report
**Evidence**: pgTAP `lives_ok(...)` on the delete and `is( (select count(*) from report_media where report_id=$r), 0 )`

## SCEN-H03: a report re-publishes after a failure is resolved
**Given**: a report that became `is_visible = true` (all processed), then had one media go `processed → failed` (now `is_visible = false`)
**When**: that failed media is re-processed back to `'processed'` (none pending/failed remain)
**Then**: `is_visible` returns to `true` (the un-publish is not permanent once the failure is resolved)
**Evidence**: pgTAP — `is_visible` is `false` after the failure and `true` again after the row returns to `'processed'`
