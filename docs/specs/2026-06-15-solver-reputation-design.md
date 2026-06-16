---
title: Solver reputation (subsystem C)
date: 2026-06-15
status: draft
epic: "Citizen reporting → validation → resolution → reputation → incentives (4 subsystems: A validation, B solvers, C reputation, D donations)"
note: Subsystem C of the larger vision. A (citizen validation/corroboration) and B (verified solvers + disputes) are already shipped. This subsystem turns B's binary "verified" badge into an EARNED, graded reputation for solvers, computed from facts already captured (resolutions, upheld disputes, reverted disputes). It is public DISPLAY plus an admin-panel SIGNAL — it does NOT gate solver powers and does NOT act automatically.
---

# Solver reputation (subsystem C)

## Problem

Subsystem B verifies solvers with a binary stamp: a profile either has the
`solver` role and a public `solver_profiles` row, or it does not. Once verified, a
solver looks identical on `/solucionadores/[handle]` whether they have delivered
fifty clean fixes or one resolution that a dispute later proved false. The crowd
that B's dispute path empowers — anyone can flag a false resolution, an admin
upholds or reverts — produces a trust signal that currently evaporates: a
reverted dispute strips the public attribution and is never tied back to the
solver who earned it. There is no graded, public record of a solver's track
record, and no cheap way for an admin to notice a solver whose resolutions keep
getting reverted.

The product vision treats **reputation** as the link between *resolution* (B) and
*incentives* (D): before the public trusts a solver — and before donations ever
flow to one — the solver's history should be visible and earned from facts, not
asserted by a badge.

## Goals

- Give each verified solver a **graded, public reputation** computed from objective
  facts already in the database: resolutions delivered, resolutions that survived a
  dispute, resolutions reverted by a dispute.
- Show the reputation **honestly** as raw counts plus a transparent reliability
  rate — no opaque score, no arbitrary tier thresholds.
- Give admins a **signal** (not an action): surface solvers with many reverted
  resolutions so a human can review them, without automating any trust decision.
- Close the data gap that makes the most important negative signal
  (reverted-resolutions-per-solver) unrecoverable today, by capturing the
  challenged solver at the moment a dispute is filed.
- Reuse the project's proven **denormalized-counts-by-trigger** pattern (subsystem
  A's `verified_count`) so reads stay O(1).

## Non-goals (separate subsystems / future)

- **Citizen reputation** (track record of reporters) → not this subsystem; a
  possible later one. C is solvers only.
- **Functional gating / tiers** — auto-revoking the `solver` role after N
  reversions, auto-verifying resolutions of high-reputation solvers without proof,
  or unlocking powers by score → explicitly rejected. Reputation informs humans;
  it never acts. The admin remains the sole authority that mints (`grant_solver`)
  or reverts (`resolve_dispute`).
- **A single numeric reputation score** or **Bronze/Silver/Gold tiers** → rejected
  (opaque weights / arbitrary thresholds hide the facts). Honest counts only; a
  visual tier could be *derived* from the reliability rate later without reworking
  the data.
- **Response-time, abandoned-claim, or citizen-corroboration signals** → out of MVP
  (they introduce arbitrary time thresholds or signals the solver does not
  control). Only the three objective, already-captured signals ship.
- **Enriching the public map popup / `reports_in_view`** with reputation → deferred
  (a costly `DROP+CREATE` of `reports_in_view` for marginal value; the full
  reputation is one click away on the solver profile).
- **Leaderboards / ranking solvers publicly** → out of scope; the admin ordering is
  an internal tool, not a public ranking.

## Design

### Decisions locked in brainstorming

- **Whose reputation**: solvers only (Q1). Turns B's binary verified badge into an
  earned, graded reputation; the signals already exist and there is a natural
  public surface (`/solucionadores/[handle]`).
- **Signals**: the three objective, already-captured facts (Q2) —
  (1) **resolved** reports (`resolved_by = S`, `status = resuelto`) [positive];
  (2) **upheld** disputes against the solver's resolutions — quality under scrutiny
  [positive]; (3) **reverted** disputes — a fix proven false [negative]. No
  response time, no abandoned claims, no citizen-corroboration coupling.
- **Effect**: public **display** plus an admin-panel **signal** (Q3). No functional
  gating; reputation informs humans, never acts. Keeps B's "admin decides" model and
  A's additive-credibility principle.
- **Representation**: honest **raw counts** plus a transparent derived **reliability
  rate** (Q4) — like A's "3 verificadas · 1 anónima", not an opaque single score and
  not arbitrary tiers.
- **Architecture**: capture the challenged solver on the dispute, then maintain
  denormalized counts on `solver_profiles` via recompute triggers — subsystem A's
  pattern (Enfoque 2). Rejected alternatives: compute-on-read recovering the
  reverted solver from `report_status_history` (fragile archaeology, brittle under
  re-resolve cycles); an event-sourced `reputation_events` ledger (over-engineering
  for three signals — the natural evolution if temporal history or more signals are
  ever needed, but YAGNI now).

### The attribution gap (why a write-path change is required)

When an admin **reverts** a dispute, `resolve_dispute` (migration `0017`) sets the
report's `resolved_at`/`resolved_by` to `NULL` and the report returns to
`en_proceso`. The `report_disputes` row records the admin (`reviewed_by`) but **not
the solver whose resolution was reverted**. So after a revert, *which solver got
reverted is gone* from both `reports.resolved_by` (nulled) and the dispute row. It
is recoverable only by archaeology over `report_status_history` (the `resuelto`
event carries `changed_by = solver`), which is brittle once a report is
resolved → reverted → re-resolved by a different solver.

C closes this gap at the **semantically correct moment**: when a dispute is filed,
the report is `resuelto` (the insert RLS policy requires it), so `resolved_by` is
exactly the solver being challenged. A `BEFORE INSERT` trigger stamps that solver
onto the dispute row, immune to the later attribution strip.

### Data model (migration `0019`)

**(a) Capture the challenged solver.** `report_disputes` gains:

| column | type | notes |
|---|---|---|
| `disputed_solver_id` | `uuid NULL` → `profiles(id)` | the solver whose resolution is challenged; stamped by a `BEFORE INSERT` trigger from `reports.resolved_by`, never supplied by the client |

A `BEFORE INSERT` trigger `report_disputes_stamp_solver` sets
`NEW.disputed_solver_id := (SELECT resolved_by FROM public.reports WHERE id =
NEW.report_id FOR SHARE)`. It **overwrites** any client-provided value
unconditionally, so the field is unforgeable (the client only ever inserts
`report_id` / `reason` / `status='open'`, exactly as today). The `FOR SHARE` pins
the report row so a concurrent `resolve_dispute` REVERT cannot null `resolved_by`
between the insert-policy's `status='resuelto'` check and this read; without it, that
vanishingly rare interleave would stamp `NULL` (under-attribution — a single lost
negative signal — never mis-attribution). If the report was resolved by staff (no
`solver_profiles` row) `resolved_by` is still a `profiles` id, but it will match no
`solver_profiles` row at count time → it contributes to nobody's reputation
(correct: staff have no solver reputation). If `resolved_by` is `NULL` the stamp is
`NULL` and counts for nobody.

**(b) Denormalized counts on `solver_profiles`** (all `int NOT NULL DEFAULT 0`):

- `resolved_count` — reports currently `status = resuelto AND is_visible = true`
  with `resolved_by = S`. The `is_visible = true` filter makes this number **equal
  the count of cards on the profile's resolved-reports wall**
  (`getSolverResolvedReports` filters the same way) — the whole design's value is
  "the number equals the cards", so a resolved-but-invisible report (e.g. complaint
  media still pending/failed) must not inflate the count past the visible wall.
- `upheld_count` — disputes with `status = 'upheld'` and `disputed_solver_id = S`.
- `reverted_count` — disputes with `status = 'reverted'` and `disputed_solver_id = S`.

**(c) Recompute triggers** (subsystem A's `report_validations_recount` philosophy —
recompute from scratch, not deltas; `coalesce(NEW, OLD)`; guard with `IS DISTINCT
FROM`; `SECURITY DEFINER`; `search_path = ''`; lock the target row `FOR NO KEY
UPDATE`):

- `solver_reputation_recount_from_reports()` — `AFTER INSERT OR UPDATE OR DELETE` on
  `reports`. Recomputes `resolved_count` (= `resuelto AND is_visible` rows for the
  solver) for the affected solver(s) — the set `{OLD.resolved_by, NEW.resolved_by}`
  minus null, intersected with existing `solver_profiles`. A revert (which nulls
  `resolved_by` and leaves `resuelto`) flows through here and decrements
  automatically; a fresh resolve increments. Because `resolved_count` now depends on
  `is_visible`, an `is_visible` flip matters — and the visibility trigger
  (`refresh_report_visibility`) writes `reports.is_visible` via an `UPDATE` on
  `reports`, which fires this AFTER trigger, so the count stays correct when a
  report's complaint media finishes (or fails) sanitization. (Same-solver, only
  `is_visible` changed → `OLD.resolved_by = NEW.resolved_by = S`, still recomputed.)
- `solver_reputation_recount_from_disputes()` — `AFTER UPDATE` on `report_disputes`
  when `status` changes. Recomputes `upheld_count` and `reverted_count` for
  `disputed_solver_id`. (A dispute is always inserted `open`, so `INSERT` never
  changes these counts.)

Both functions are no-ops when the target solver is null or has no `solver_profiles`
row (`UPDATE … WHERE id = sid` simply matches nothing).

**(d) Backfill (in-migration, idempotent).** Initialize the three counts for every
existing `solver_profiles` row from current data. For historical
`disputed_solver_id`: `upheld` disputes recover it directly from
`reports.resolved_by` (uphold preserves attribution); `reverted` disputes recover it
best-effort from the latest `resuelto` event in `report_status_history` before the
dispute's `reviewed_at`. Production almost certainly has zero historical disputes,
so the fragile `reverted` path is near-certainly empty — documented as a known
limitation, not a silent assumption.

This migration **does not modify** `resolve_dispute` or `change_report_status`; the
triggers react to their effects.

### Computation & representation

Count semantics, made precise so pgTAP and the UI measure the same thing:

| count | exact definition | sign |
|---|---|---|
| `resolved_count` | standing `resuelto AND is_visible` reports with `resolved_by = S` (matches the profile wall) | + |
| `upheld_count` | `upheld` disputes with `disputed_solver_id = S` | + (held up under scrutiny) |
| `reverted_count` | `reverted` disputes with `disputed_solver_id = S` | − |

No double counting: an `upheld` dispute leaves its report `resuelto` with
`resolved_by = S`, so it is **already inside** `resolved_count`; `upheld_count` is a
highlighted subset ("these survived a challenge"), not an additional tally. A
`reverted` dispute's report left `resuelto` (now `en_proceso`, `resolved_by` null),
so it is **not** in `resolved_count` — `reverted_count` is an independent historical
fact.

**Reliability rate** — derived, transparent, never an arbitrary weight:

```
reliability = resolved_count / (resolved_count + reverted_count)
```

- No reversions → 100%.
- `resolved_count + reverted_count = 0` (a freshly verified solver) → **no rate**:
  the UI shows "Sin historial aún", never "0%" or "NaN" (a new solver is not 0%
  reliable).
- Rounding is **round-half-up to an integer percent**, defined in the service so the
  UI and tests agree (e.g. `47/49 = 95.9% → 96%`).
- Re-resolve cycle: a reverted report later re-resolved by the same solver re-enters
  `resolved_count` and keeps its `reverted_count` — honest ("failed once, fixed it
  later"); the reversion is never cancelled.

Public display, e.g.:

> **47 resueltos · 3 sostenidas en disputa · 2 revertidas — 96% de fiabilidad**

UI-copy caution for the C3 chunk: "sostenidas en disputa" (`upheld_count`) is a
**subset** of "resueltos" (`resolved_count`), not a third disjoint bucket — copy
should signal the subset relationship (e.g. "3 de ellos sostenidas en disputa") so a
layperson does not read 47 + 3 + 2. Final wording goes through `/humanizer`.

### Read path / surfaces

- **Public solver profile `/solucionadores/[handle]`** — the primary home.
  `solverService.getSolverProfileByHandle` / `SolverProfile` gain
  `resolvedCount` / `upheldCount` / `revertedCount` (read directly from
  `solver_profiles`) plus a derived `reliability`. A reputation block renders in
  `ProfileHeader`. (The page already shows the wall of resolved reports; the block
  adds the upheld/reverted/reliability facts.)
- **Report-detail attribution badge** — `reportDetailService` already looks up
  `solver_profiles` to resolve attribution (`SolverAttribution`); it adds
  `resolved_count` to that existing select and `resolvedCount` to the type. The
  `AttributionBadge` shows a compact "· 47 resueltos" after the type chip.
- **Admin panel signal** (Q3) — a `/panel` section "Solucionadores", admin-gated,
  ordered by `reverted_count DESC` then reliability ascending, showing handle + the
  three counts + rate, so an admin spots problematic solvers at a glance.
- **Deferred**: map popup / `reports_in_view` enrichment — `reports_in_view` stays
  v3 (no `DROP+CREATE`); the full reputation is one click away on the profile.

### Authz / RLS / abuse

- `disputed_solver_id` is stamped only by the `BEFORE INSERT` trigger, which
  overwrites any client payload → unforgeable. The dispute insert RLS policy is
  unchanged and never references the column.
- The three counts have **no client write path**: `solver_profiles` already has only
  `solver_profiles_select_public` (no client INSERT/UPDATE/DELETE policy); the counts
  are maintained exclusively by the DEFINER triggers. No new grant — they inherit the
  existing public `SELECT`.
- The trigger functions are `SECURITY DEFINER`, `search_path = ''`, fully-qualified,
  and `REVOKE EXECUTE … FROM public, anon, authenticated` (they are trigger-only,
  never RPC-reachable) → they do **not** enter the advisor `0028`/`0029` baseline.
- **Visibility is honest**: the counts are **public by design**
  (`solver_profiles.select_public USING (true)`) — that is the point, public
  reputation. The admin-panel "Solucionadores" section is **UX/workflow** gating (the
  reverted-ordered view is an admin tool), **not** a confidentiality boundary. What
  stays admin-only is `report_disputes` itself (who disputed and why) — its
  read-RLS is untouched, so no disputer is leaked.

## Observable scenarios (SDD holdout)

- **SCEN-C-001 (stamp on file)** — Given a `resuelto` report with `resolved_by = S`,
  when anyone files a dispute against it, then the new `report_disputes` row has
  `disputed_solver_id = S`, even if the client payload tried to set a different
  value.
- **SCEN-C-002 (resolve increments)** — Given a verified solver `S`, when `S`
  resolves a **visible** report (→ `resuelto`, `is_visible = true`), then
  `S.resolved_count` increases by 1.
- **SCEN-C-003 (uphold keeps resolved, increments upheld)** — Given a disputed
  `resuelto` report by `S`, when the admin **upholds** the dispute, then
  `S.upheld_count` increases by 1 and `S.resolved_count` is unchanged (the report is
  still `resuelto`).
- **SCEN-C-004 (revert decrements resolved, increments reverted)** — Given a disputed
  visible `resuelto` report by `S` (counted in `S.resolved_count`), when the admin
  **reverts** the dispute, then `S.reverted_count` increases by 1 and
  `S.resolved_count` decreases by 1 (the report left `resuelto`).
- **SCEN-C-005 (staff-resolved → no solver reputation)** — Given a report resolved by
  a staff member (no `solver_profiles` row) that is disputed and reverted, then no
  `solver_profiles` row's counts change.
- **SCEN-C-006 (reliability rate)** — Given `S` with `resolved_count = 47` and
  `reverted_count = 2`, then `S`'s reliability renders as `96%`; given
  `resolved_count = reverted_count = 0`, then it renders "Sin historial aún" (never
  0% / NaN).
- **SCEN-C-007 (profile surface)** — Given `S` with counts, when the public profile
  `/solucionadores/[handle]` is read, then the reputation block shows the three
  counts and the reliability rate.
- **SCEN-C-008 (detail attribution surface)** — Given a `resuelto` report attributed
  to `S`, when the report detail is read, then the attribution badge shows
  `S.resolved_count` next to "Resuelto por @handle".
- **SCEN-C-009 (admin signal ordering)** — Given two solvers with different
  `reverted_count`s, when an admin views the `/panel` "Solucionadores" section, then
  the solver with more reversions is listed first.
- **SCEN-C-010 (counts are public, disputers are not)** — Given a solver's counts,
  an anonymous client can read them (public reputation) via `solver_profiles`, but
  cannot read any `report_disputes` row (who disputed stays admin-only).

## Testing strategy

- **pgTAP** (`solver_reputation_test.sql`), isolated fixtures (solver + reports +
  disputes built in the test): the stamp trigger (including the overwrite-forged-value
  case); `resolved_count` on resolve; `upheld_count` up + `resolved_count` unchanged
  on uphold; `reverted_count` up + `resolved_count` down on revert; null
  `disputed_solver_id` (staff-resolved) touches nobody; backfill correctness; RLS
  unchanged (`report_disputes` admin-only read, `solver_profiles` world-readable).
  Assert counts by **reading the columns** from `solver_profiles`, not by recomputing
  (the B3.3 false-green lesson). Adjust `plan(...)`. (Note: there are no existing
  `columns_are` whitelist tests in `supabase/tests/` to update; if the chunk adds a
  `columns_are`/`has_column` assertion it should cover `disputed_solver_id` and the
  three new counts, but that is a new assertion, not an edit to an existing one.)
- **vitest** (service): the reliability formula — normal (47/2 → 96%), 100% (no
  reversions), divide-by-zero (0+0 → "Sin historial aún"), and round-half-up
  determinism; the count mapping in `solverService` / `reportDetailService`.
- **Runtime (agent-browser, local stack)**: profile reputation block after seeding
  real resolutions/disputes; detail attribution badge "· N resueltos"; admin panel
  "Solucionadores" ordering; console clean, no failed requests.

The observable scenarios above are the SDD holdout — satisfaction is measured
against them, not against the tests; a scenario is never weakened to match code.

## Implementation chunks

- **C1** — migration `0019` (`report_disputes.disputed_solver_id` + stamp trigger +
  `solver_profiles` counts + recompute triggers + backfill) +
  `solver_reputation_test.sql` pgTAP.
- **C2** — application layer: reliability service (formula + rounding + div-by-zero),
  `solverService` / `reportDetailService` count fields + vitest.
- **C3** — UI: profile reputation block, detail attribution badge enrichment, admin
  panel "Solucionadores" section + vitest, `globals.css`.
- **C4** — runtime verification (agent-browser, local stack) closing the scenarios.

(Final chunking is sop-planning's call; this is the expected shape.)

## Files / migrations / blast radius

- **NEW**: `supabase/migrations/0019_solver_reputation.sql`,
  `supabase/tests/solver_reputation_test.sql`, a reliability helper module (e.g.
  `src/lib/reputation/reliability.ts`) (+ test).
- **MODIFIED**: `src/lib/services/solverService.ts` (+ count fields on
  `SolverProfile`), `src/lib/services/reportDetailService.ts` (+ `resolvedCount` on
  `SolverAttribution`), `src/app/(public)/solucionadores/[handle]/page.tsx`
  (reputation block), `src/app/(public)/reportes/[id]/page.tsx` (`AttributionBadge`
  enrichment), `src/app/(panel)/panel/page.tsx` (admin "Solucionadores" section),
  `src/app/globals.css` (`.solver-reputation*`).
- **Blast radius note**: the migration only **adds** a column + three counts + three
  triggers; it does not touch `resolve_dispute`, `change_report_status`, or
  `reports_in_view`. `report_disputes` grows by one column, `solver_profiles` by
  three. No public-map or visibility path changes. The dispute filing path is
  unchanged for clients (the stamp is server-side and transparent).

## Rollout plan

- Migration `0019` applies cleanly from `0018` (subsystem A). Additive only;
  existing solvers backfill their counts in the same migration.
- Per-chunk: pgTAP + vitest + `next build` green, `/verification-before-completion`
  before each commit, push per explicit user authorization (the established cadence).
  CI `db.yml` already triggers on `supabase/tests/**`, so the pgTAP runs.
- Backfill consequence: existing solvers show counts computed from current data; the
  historical `reverted` attribution is best-effort (near-certainly empty in prod).
  No reputation is retroactively invented — a deliberate, product-visible choice.
