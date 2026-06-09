---
name: solver-resolution
created_by: brainstorming
created_at: 2026-06-08T00:00:00Z
spec: docs/specs/2026-06-08-solver-resolution-design.md
note: Subsystem B — verified solvers (government/influencer/org, admin-curated) claim and resolve reports with public proof (photo+video) and public attribution. Reuses the existing report_status workflow + media pipeline. Attribution via auth.uid() (no forgery). Works with anonymous-majority reports. Disputes flag → admin revert. Split into chunks B1 (identity), B2 (resolution+attribution), B3 (disputes).
---

# Scenarios — solvers + public resolution attribution (subsystem B)

A verified solver turns a complaint into a visible, proven solution. The original
reporter is usually anonymous, so resolution cannot depend on them; trust comes from
admin-verified solver identity + public proof + a dispute path.

---

## SCEN-001 (B2, E1 — claim)
**Given**: a verified solver and a `nuevo` report
**When**: they claim it
**Then**: the report is `en_proceso` with `reports.claimed_by = solver` and `claimed_at` set; the public detail and map show "En proceso por @handle"
**Evidence**: pgTAP — `change_report_status` to `en_proceso` as `solver` sets `claimed_by = auth.uid()`. agent-browser — the badge renders.

## SCEN-002 (B2, E1 — resolve with proof)
**Given**: a solver on a report that has ≥1 processed `kind='resolution'` media
**When**: they mark it resolved
**Then**: status is `resuelto`, `resolved_by = solver`, `resolved_at` set, a `report_status_history` row is written, and the detail shows before/after media + "Resuelto por @handle"
**Evidence**: pgTAP — resolve sets `resolved_by = auth.uid()` + audit row. agent-browser — before/after + attribution render.

## SCEN-003 (B2 — proof required)
**Given**: a solver on a report with NO processed resolution media
**When**: they try to resolve
**Then**: the RPC raises (`P0001`) and the status is unchanged
**Evidence**: pgTAP — `throws_ok` on resolve without proof; status assertion unchanged.

## SCEN-004 (B2 — authz)
**Given**: a `citizen` or anonymous caller; separately, a `solver`
**When**: the citizen/anon calls claim/resolve; the solver calls `descartado`
**Then**: both are rejected (`42501`) and nothing changes; staff/admin retain all transitions
**Evidence**: pgTAP — `throws_ok` 42501 for citizen claim/resolve and for solver→descartado; status unchanged.

## SCEN-005 (B2 — anonymous report resolvable)
**Given**: a report whose `reporter_id` is null, with proof media
**When**: a solver resolves it
**Then**: it succeeds with no dependency on the reporter
**Evidence**: pgTAP — resolve succeeds on a null-reporter report.

## SCEN-006 (B2 — no self-attribution forgery)
**Given**: a solver calling the resolve RPC
**When**: the RPC sets `resolved_by`/`claimed_by`
**Then**: they equal `auth.uid()` regardless of any client-supplied value (no client arg for attribution)
**Evidence**: pgTAP — `resolved_by` equals the session uid; the RPC signature carries no attribution param.

## SCEN-007 (B3 — dispute revert)
**Given**: a `resuelto` report
**When**: a dispute is filed and an admin reverts it
**Then**: the report returns to `en_proceso`, `resolved_by` and `resolved_at` are cleared (NULL), the public attribution disappears, and the audit trail records the revert
**Evidence**: pgTAP — after `resolve_dispute(... revert)`, `resolved_at`/`resolved_by` are NULL, status `en_proceso`, history row present.

## SCEN-008 (B2 — solver profile page)
**Given**: a verified solver with resolved reports
**When**: anyone opens `/solucionadores/[handle]`
**Then**: it lists their `resuelto` reports with before/after thumbnails and no PII beyond the public solver profile; an unknown handle 404s
**Evidence**: agent-browser / integration — the page renders the resolved list; unknown handle → 404.

## SCEN-009 (B2 — runtime, web)
**Given**: a verified solver session in a real browser
**When**: they claim → upload proof (photo+video) → resolve via the UI
**Then**: the report shows `resuelto` + attribution on the public detail/map, the page has zero console errors and no failed requests
**Evidence**: agent-browser — the full solver flow runs clean; the report appears resolved with the solver's attribution.

## SCEN-010 (B1 — admin-only solver grant)
**Given**: an admin; separately a non-admin
**When**: each calls `grant_solver(user, handle, type)`
**Then**: the admin call sets `profiles.role='solver'` + inserts a `solver_profiles` row; the non-admin call is rejected (`42501`); `anon` has no EXECUTE on the function
**Evidence**: pgTAP — admin grant succeeds (role+profile), non-admin raises 42501, grant assertions show no anon/public EXECUTE.
