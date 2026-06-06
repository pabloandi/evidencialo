---
name: panel-status-change
created_by: orchestrator
created_at: 2026-06-05T00:00:00Z
step: 13
note: Staff management panel — a filterable report list + an AUDITED status-change write path. Only staff/admin may change a report's status; every change writes a `report_status_history` row; moving to `resuelto` sets `resolved_at`. Authz is enforced at TWO layers (the route's getSessionRole 403 + the SECURITY DEFINER RPC's private.is_staff() guard). Server scenarios run as unit/pgTAP/integration; the panel UI + status change are arbitrated by /agent-browser with a staff session.
---

# Scenarios — panel status change + audit

The municipal staff panel lists reports (filterable by status/category) and lets
staff change a report's status. The change is a single atomic, audited write: it
updates `reports.status`, appends a `report_status_history` row, and — when the new
status is `resuelto` — stamps `resolved_at`. Only staff/admin can do it; a citizen
or anonymous caller is refused with no state change.

---

## SCEN-001 (E3): a citizen cannot change status
**Given**: an authenticated `citizen` user and a report
**When**: they `POST /api/reports/[id]/status` with a new status
**Then**: the response is `403` and the report's status is unchanged (no history row written)
**Evidence**: unit — the route returns 403 when `getSessionRole` yields a non-staff role; the service/RPC is never invoked

## SCEN-002 (E3): an anonymous caller cannot change status
**Given**: no session (anonymous)
**When**: `POST /api/reports/[id]/status`
**Then**: the response is `403` (role is null → not staff); no state change
**Evidence**: unit — 403 for a null role

## SCEN-003 (E4): a staff change is applied and audited
**Given**: a `staff` user and a report in status `nuevo`
**When**: they change it to `en_proceso` with a note
**Then**: `reports.status` becomes `en_proceso` AND a `report_status_history` row is inserted with `from_status='nuevo'`, `to_status='en_proceso'`, `changed_by=<the staff user id>`, and the note
**Evidence**: pgTAP/integration — after the call, the report's status is `en_proceso` and exactly one new history row carries the expected from/to/changed_by/note

## SCEN-004 (E7): resolving stamps resolved_at
**Given**: a `staff` user and a report in `en_proceso` with `resolved_at` null
**When**: they change it to `resuelto`
**Then**: `reports.resolved_at` is set to the change timestamp (non-null)
**Evidence**: pgTAP/integration — `resolved_at` is non-null after the transition; a transition to a non-`resuelto` status leaves `resolved_at` unchanged

## SCEN-005: an invalid target status is rejected
**Given**: a `staff` user
**When**: they POST a status that is not one of `nuevo|en_proceso|resuelto|descartado`
**Then**: the response is `400` and nothing changes (no status update, no history row)
**Evidence**: unit — 400 for a body failing the status enum validation; the service is not called

## SCEN-006: an unknown report id is 404
**Given**: a `staff` user
**When**: they POST a status change for an id that matches no report
**Then**: the response is `404`
**Evidence**: unit/pgTAP — the RPC raises a not-found condition the route maps to 404

## SCEN-007 (DB is the boundary): the RPC refuses a non-staff caller directly
**Given**: a caller invoking `change_report_status` DIRECTLY (bypassing the route) under a non-staff role
**When**: the RPC runs
**Then**: it raises (forbidden) — the status is not changed and no history row is written; authz does not rest on the HTTP layer alone
**Evidence**: pgTAP — calling the RPC with a `citizen` (or anon) jwt claim raises; with a `staff` claim it succeeds

## SCEN-008 (atomicity): status and audit are written together
**Given**: a staff status change
**When**: the change runs
**Then**: the status update and its history row commit together — there is never a changed `reports.status` without a corresponding `report_status_history` row (and vice versa)
**Evidence**: pgTAP — within one transaction, after the RPC the new status and its single matching history row both exist; `from_status` equals the status the report had before the call

## SCEN-009 (panel runtime): staff sees the filterable list and can change status
**Given**: an authenticated `staff` session and at least one report
**When**: they open `/panel`, filter by status/category, and change a report's status via the control
**Then**: the list shows the reports (respecting filters) and, after the change, the row reflects the new status — with zero console errors
**Evidence**: agent-browser — the panel renders the list; submitting a status change updates the displayed status; console clean

## SCEN-010 (gate): non-staff cannot reach the panel
**Given**: a `citizen` or anonymous visitor
**When**: they navigate to `/panel`
**Then**: they are redirected away (the panel never renders for them)
**Evidence**: agent-browser / runtime — `/panel` as a non-staff visitor lands on `/` (redirect), not the panel
