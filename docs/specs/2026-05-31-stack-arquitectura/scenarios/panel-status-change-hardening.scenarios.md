---
name: panel-status-change-hardening
created_by: orchestrator
created_at: 2026-06-05T00:00:00Z
step: 13
note: Additive hardening from the step13 quality review (edge-case HIGH no-op audit/resolved_at + MEDIUM error-contract). Sibling holdout to panel-status-change.scenarios.md. The StatusControl select defaults to the report's CURRENT status, so "Guardar" with no change submits the same status — that no-op must not pollute the audit trail or drift `resolved_at`.
---

# Scenarios — panel status change hardening (review findings)

The first cut wrote an audit row and re-stamped `resolved_at` for EVERY accepted
call, including a no-op where the new status equals the current one — the easiest
action to trigger (the panel's status select defaults to the current value). That
pollutes the audit trail (a `from==to` row) and silently moves a resolved report's
`resolved_at` forward. Hold alongside SCEN-001..010.

---

## SCEN-H01: a no-op status change is inert (no audit row, no resolved_at drift)
**Given**: a `staff` user and a report already in status `resuelto` with a fixed `resolved_at`
**When**: they submit the SAME status (`resuelto`) — a no-op (`from_status == to_status`)
**Then**: nothing is written — NO new `report_status_history` row is appended, and `resolved_at` is NOT re-stamped (its prior timestamp is preserved). The call still succeeds (returns the current row) so the UI refreshes cleanly
**Evidence**: pgTAP — after a same-status call, the history row count is unchanged and `resolved_at` equals its prior value; the call does not raise

## SCEN-H02: a real change after a no-op still audits correctly
**Given**: a report on which a no-op was just attempted
**When**: a staff makes a genuine change (`from != to`)
**Then**: exactly one history row is written with the true `from_status` (the unchanged current status), confirming the no-op guard did not corrupt the captured pre-state
**Evidence**: pgTAP — the genuine change writes one row with the correct from/to

## SCEN-H03: a wrong-typed note is rejected with an accurate error code
**Given**: a request whose `note` is not a string (e.g. a number or array) — distinct from a too-long note
**When**: the body is validated
**Then**: the response is `400` with a code that reflects the actual problem (`note_invalid` for a type error), NOT `note_too_long` (which must be reserved for the length violation)
**Evidence**: unit — a non-string note yields `code: 'note_invalid'`; a >1000-char note yields `code: 'note_too_long'`
