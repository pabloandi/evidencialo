---
name: solver-reputation
created_by: brainstorming
created_at: 2026-06-15T00:00:00Z
spec: docs/specs/2026-06-15-solver-reputation-design.md
note: Subsystem C — earned, graded reputation for verified solvers, computed from facts B already captures. Three signals: resolved_count (standing resuelto AND is_visible reports by the solver — equals the profile wall), upheld_count (disputes against the solver the admin upheld — a highlighted subset of resolved, NOT additive), reverted_count (disputes reverted — a fix proven false). reliability = resolved/(resolved+reverted); denominator 0 → "Sin historial aún" (never 0%/NaN); round-half-up to integer percent. The challenged solver is captured on the dispute by a BEFORE INSERT stamp from reports.resolved_by (FOR SHARE), closing the gap where a revert nulls resolved_by. Denormalized counts on solver_profiles maintained by recompute triggers (subsystem A's pattern); no client write path; trigger-only DEFINER fns. Public DISPLAY (profile + detail badge) + an admin-panel SIGNAL; no functional gating. Chunks C1 (migration 0019 + pgTAP), C2 (reliability service + count fields), C3 (UI: profile block + detail badge + admin section), C4 (runtime). SCEN-001..010 here map 1:1 to the spec's SCEN-C-001..010.
---

# Scenarios — solver reputation (subsystem C)

Each verified solver earns a graded, public reputation from objective facts: how
many reports they resolved (and still stand), how many of their resolutions
survived a dispute, how many were reverted as false. Reputation is shown honestly
as raw counts plus a transparent reliability rate. It is public display plus an
admin signal — it never gates a solver's powers and never acts on its own. The
challenged solver is captured the moment a dispute is filed, so a later revert
(which strips the public attribution) cannot erase the negative signal.

---

## SCEN-001 (C1 — stamp the challenged solver on the dispute)
**Given**: a `resuelto` report with `resolved_by = S`
**When**: anyone files a dispute against it (even if the client payload tries to set a different `disputed_solver_id`)
**Then**: the new `report_disputes` row has `disputed_solver_id = S` (server-stamped, client value ignored)
**Evidence**: pgTAP — after a client-style INSERT (with a forged `disputed_solver_id`) against a report resolved by `S`, the stored row's `disputed_solver_id = S`.

## SCEN-002 (C1 — resolve increments resolved_count)
**Given**: a verified solver `S`
**When**: `S` resolves a **visible** report (→ `resuelto`, `is_visible = true`)
**Then**: `solver_profiles.resolved_count` for `S` increases by 1
**Evidence**: pgTAP — read `resolved_count` from `solver_profiles` before/after the resolve; it rises by exactly 1.

## SCEN-003 (C1 — uphold keeps resolved, increments upheld)
**Given**: a disputed visible `resuelto` report by `S` (counted in `S.resolved_count`)
**When**: the admin **upholds** the dispute (`resolve_dispute … 'uphold'`)
**Then**: `S.upheld_count` increases by 1 and `S.resolved_count` is unchanged (the report stays `resuelto`)
**Evidence**: pgTAP — read both counts from `solver_profiles`: `upheld_count` +1, `resolved_count` unchanged.

## SCEN-004 (C1 — revert decrements resolved, increments reverted)
**Given**: a disputed visible `resuelto` report by `S` (counted in `S.resolved_count`)
**When**: the admin **reverts** the dispute (`resolve_dispute … 'revert'`)
**Then**: `S.reverted_count` increases by 1 and `S.resolved_count` decreases by 1 (the report left `resuelto`)
**Evidence**: pgTAP — read both counts: `reverted_count` +1, `resolved_count` −1.

## SCEN-005 (C1 — staff-resolved report earns no solver reputation)
**Given**: a report resolved by a staff member (a `profiles` id with no `solver_profiles` row)
**When**: that report is disputed and the admin reverts (or upholds) it
**Then**: no `solver_profiles` row's counts change (the stamp is a non-solver id → matches nobody)
**Evidence**: pgTAP — every `solver_profiles` row's `resolved_count`/`upheld_count`/`reverted_count` is unchanged across the dispute resolution.

## SCEN-006 (C2 — reliability rate, including the empty case)
**Given**: a solver with `resolved_count` and `reverted_count`
**When**: the reliability rate is computed for display
**Then**: it is `resolved / (resolved + reverted)` as a round-half-up integer percent (e.g. 47/2 → `96%`); when `resolved + reverted = 0` it is "Sin historial aún" (never `0%` or `NaN`)
**Evidence**: vitest — the reliability helper returns 96 for (47,2), 100 for (n,0), the empty-state sentinel for (0,0), and round-half-up at the .5 boundary.

## SCEN-007 (C3 — public profile reputation block)
**Given**: a solver `S` with reputation counts
**When**: the public profile `/solucionadores/[handle]` is read
**Then**: the reputation block shows the three counts and the reliability rate, and `resolved_count` equals the number of cards on the resolved-reports wall
**Evidence**: vitest — `solverService` exposes the three counts on `SolverProfile`. agent-browser — the block renders the counts + rate and the count matches the wall.

## SCEN-008 (C3 — detail attribution badge enrichment)
**Given**: a `resuelto` report attributed to solver `S`
**When**: the report detail page is read
**Then**: the attribution badge shows `S.resolved_count` next to "Resuelto por @handle"
**Evidence**: vitest — `reportDetailService` exposes `resolvedCount` on `SolverAttribution`. agent-browser — the detail badge shows "· N resueltos".

## SCEN-009 (C1/C3 — admin signal ordering)
**Given**: two solvers with different `reverted_count`s
**When**: an admin views the `/panel` "Solucionadores" section
**Then**: the solver with more reversions is listed first (ordered by `reverted_count DESC`, then reliability ascending)
**Evidence**: pgTAP/query — the admin ordering query returns the higher-`reverted_count` solver first. agent-browser — the panel lists it first.

## SCEN-010 (C1 — counts are public, disputers are not)
**Given**: a solver's reputation counts and the `report_disputes` rows behind them
**When**: an anonymous client reads `solver_profiles` and attempts to read `report_disputes`
**Then**: the counts are readable (public reputation), but no `report_disputes` row is (who disputed stays admin-only)
**Evidence**: pgTAP — anon select on `solver_profiles` returns the counts; anon select on `report_disputes` returns 0 rows.
