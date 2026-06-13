---
name: citizen-validation
created_by: brainstorming
created_at: 2026-06-12T00:00:00Z
spec: docs/specs/2026-06-12-citizen-validation-design.md
note: Subsystem A — citizen/witness corroboration of the ORIGINAL report. Hybrid (authenticated + anonymous, weighted) confirmations; the report author is an implicit verified validation. Earns a public "Corroborado" badge at verified ≥ 3 (configurable); anonymous confirmations do not move the badge but feed a solver/staff priority score at reduced weight (priority = verified + anon/4). Positive-only (no fake/duplicate voting). Does NOT gate publication or reorder the public map. Denormalized counts on reports maintained by a recompute trigger; writes only via the validate_report DEFINER RPC. Chunks A1 (DB+pgTAP), A2 (service+API), A3 (UI), A4 (runtime). SCEN-001..010 here map 1:1 to the spec's SCEN-A-001..010.
---

# Scenarios — citizen validation / corroboration (subsystem A)

Other citizens corroborate that an original report is real ("yo también lo veo").
Corroboration is additive trust: it earns a public "Corroborado" badge and feeds
solver/staff prioritization, but never hides a report and never gates publication.
Trust is anchored to authenticated confirmations (the author counts as the first);
anonymous confirmations add reach and impact but cannot forge the badge.

---

## SCEN-001 (A1 — verified confirm)
**Given**: a visible `nuevo` report authored by an authenticated user (`verified_count = 1`)
**When**: a *different* authenticated user confirms it via `validate_report`
**Then**: a `report_validations` row exists for that user (`validator_id = auth.uid()`, `ip_hash` NULL) and `reports.verified_count = 2`
**Evidence**: pgTAP — after the RPC as a second authenticated user, the row exists and `verified_count = 2`.

## SCEN-002 (A1/A3 — badge threshold)
**Given**: a report with `verified_count = 2`
**When**: a 3rd distinct authenticated user confirms it
**Then**: `verified_count = 3` and the report is corroborated (`verified_count >= CORROBORATION_THRESHOLD`), so the public detail/map show the "Corroborado" badge
**Evidence**: pgTAP — `verified_count = 3`. agent-browser — the badge renders once the threshold is crossed.

## SCEN-003 (A1 — anonymous confirm + weight)
**Given**: a visible report
**When**: an anonymous visitor (captcha ok) confirms it via `validate_report` with an `ip_hash`
**Then**: `anon_count` increments, `verified_count` is unchanged, and `priority_score = verified_count + anon_count / 4` (integer division; 4 anon → +1)
**Evidence**: pgTAP — `anon_count` rises, `verified_count` unchanged; `priority_score` read from the `reports` column matches the formula (not recomputed in the test).

## SCEN-004 (A1 — idempotent dedup)
**Given**: a user (or an IP) that already confirmed a report
**When**: the same identity confirms it again
**Then**: no new `report_validations` row is added, the counts are unchanged, and the call reports it was not newly added (API → 200, not 201)
**Evidence**: pgTAP — a second `validate_report` for the same `(report_id, validator_id)` / `(report_id, ip_hash)` adds 0 rows and leaves counts unchanged.

## SCEN-005 (A1 — not validatable)
**Given**: a `resuelto`, `descartado`, or hidden (`is_visible = false`) report
**When**: anyone tries to confirm it
**Then**: the attempt is rejected (RPC raises → API 409 not-validatable) and no `report_validations` row is added
**Evidence**: pgTAP — `validate_report` against a non-(`nuevo`|`en_proceso`)-and-visible report raises and inserts nothing.

## SCEN-006 (A1 — author implicit validation)
**Given**: an authenticated user creates a report
**When**: the report row is inserted
**Then**: a verified `report_validations` row for the author exists and `verified_count = 1` immediately; an anonymous report (no `reporter_id`) starts at `verified_count = 0`
**Evidence**: pgTAP — after inserting an authored report the seed row exists and `verified_count = 1`; an anonymous report has `verified_count = 0`.

## SCEN-007 (A1/A3 — read surfaces)
**Given**: a report with corroboration counts
**When**: it is read via `reports_in_view` (map bbox) and via the report detail page
**Then**: `verified_count` and `anon_count` are present and the derived "Corroborado" badge shows wherever the threshold is met
**Evidence**: pgTAP — `reports_in_view` v3 returns both counts. agent-browser — detail + map popup show the counts/badge.

## SCEN-008 (A1 — RLS privacy)
**Given**: `report_validations` with rows from several users
**When**: a non-admin reads the table, an anonymous client reads the table, and any client attempts a direct INSERT
**Then**: a non-admin sees only their own rows, an anonymous client sees 0 rows (no enumeration), and a direct client INSERT is refused (writes only via the DEFINER RPC)
**Evidence**: pgTAP — select-own returns only the caller's rows, anon select returns 0 rows, a direct client INSERT raises.

## SCEN-009 (A2 — anti-abuse gates)
**Given**: the `POST /api/reports/[id]/validate` endpoint
**When**: an anonymous caller omits/fails the captcha, or any caller exceeds the rate limit, or a verified author re-confirms
**Then**: the anonymous no-captcha call is rejected (403), the over-limit call is rejected (429), and the author re-confirm is a no-op (dedup; counts unchanged)
**Evidence**: unit/integration — the route returns 403 for anon-without-captcha, 429 when rate-limited; the author re-confirm adds no row.

## SCEN-010 (A1/A3 — priority ordering)
**Given**: two open reports with different `priority_score`s
**When**: staff view the `/panel` queue
**Then**: the reports are ordered by `priority_score DESC` (more-corroborated first), without changing the public map order
**Evidence**: pgTAP — `priority_score` ordering is correct on the column. agent-browser — the panel lists the higher-priority report first.
