---
title: Implementation plan — solver reputation (subsystem C)
date: 2026-06-15
spec: docs/specs/2026-06-15-solver-reputation-design.md
scenarios: docs/specs/2026-05-31-stack-arquitectura/scenarios/solver-reputation.scenarios.md
---

# Implementation plan — subsystem C

Holdout: SCEN-001..010 (committed before code) in `solver-reputation.scenarios.md`.
Four independently-shippable chunks. The migration is applied to the remote Supabase
project **before** the app code that reads the new columns, then deployed via the
existing auto-deploy. Next migration number: **0019** (0018 = report_validations).
pgTAP lives in `supabase/tests/`.

Cross-chunk rule (DB discipline, carried from subsystems A/B): apply migration → verify
with pgTAP + `get_advisors` (the trigger-only DEFINER functions are revoked from
public/anon/authenticated → **no new anon-EXECUTE**; the 0028/0029 baseline is unchanged;
no RLS gaps) → THEN merge the app code that reads it. Per-chunk: `tsc`/`eslint`/`vitest`/
`next build` green + `/verification-before-completion` gate before each commit; push only
on explicit user authorization.

Key invariants the plan must preserve (from the spec + reviewer):
- `resolved_count` is `resuelto AND is_visible` scoped, so it **equals the profile wall**
  (`getSolverResolvedReports` filters the same way).
- `upheld_count` is a highlighted **subset** of `resolved_count` (not additive); the
  reliability denominator is `resolved + reverted` only.
- `disputed_solver_id` is stamped server-side `BEFORE INSERT` with `FOR SHARE` on the
  report row; clients cannot forge it; the existing `disputeService` insert
  (`return=minimal`, no `disputed_solver_id`) is unchanged.
- Trigger functions are DEFINER, `search_path=''`, `REVOKE EXECUTE … FROM public, anon,
  authenticated` (trigger-only). The migration does NOT modify `resolve_dispute` or
  `change_report_status`.

---

## Chunk C1: Reputation data model, stamp + recompute triggers, backfill

Foundation. No public behavior change until C2/C3 surface it. Satisfies the DB half of
SCEN-001..005, the ordering half of SCEN-009, and SCEN-010.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `…/scenarios/solver-reputation.scenarios.md` | NEW (done) | SDD holdout |
| `supabase/migrations/0019_solver_reputation.sql` | NEW | `report_disputes += disputed_solver_id uuid → profiles(id)`; `report_disputes_stamp_solver` `BEFORE INSERT` trigger (`SELECT resolved_by … FOR SHARE`, overwrites client value); `solver_profiles += resolved_count, upheld_count, reverted_count` (int not null default 0); `solver_reputation_recount_from_reports()` `AFTER INSERT/UPDATE/DELETE on reports` + `solver_reputation_recount_from_disputes()` `AFTER UPDATE on report_disputes` (recompute, `coalesce(new,old)`, `is distinct from`, `for no key update`, DEFINER `search_path=''`, execute revoked from public/anon/authenticated); in-migration backfill (counts for all solver_profiles; `disputed_solver_id` for historical `upheld` from `reports.resolved_by`, best-effort `reverted` from `report_status_history`) |
| `supabase/tests/solver_reputation_test.sql` | NEW | pgTAP for SCEN-001..005, 009 (ordering), 010 |

### Steps
- [ ] **C1.1 — Migration `0019`** | Size: L | Deps: none — author the column, stamp
  trigger, `solver_profiles` counts, both recompute triggers, and the backfill, exactly as
  the spec's Data model section. Apply to a **local** stack first (`supabase db reset`).
  **Fission point**: if this runs long, only the historical `disputed_solver_id` recovery
  for `reverted` disputes (the `report_status_history` archaeology) is truly deferrable — the
  triggers keep counts correct going forward regardless. The **count initialization**
  (resolved/upheld/reverted from current data) must ship WITH the DDL+triggers, or existing
  solvers sit at `DEFAULT 0` until their next resolve/dispute event re-triggers a recompute.
  The migration otherwise ships as one transactional unit (atomic DDL).
  - **Accept**: `supabase db reset` applies `0019` clean on a local stack; `resolve_dispute`
    / `change_report_status` / `reports_in_view` are untouched (diff shows no changes to
    them).
- [ ] **C1.2 — pgTAP `solver_reputation_test.sql`** | Size: L | Deps: C1.1 — isolated
  fixtures (a solver `S` + reports + disputes built in the test). Encode: SCEN-001 (file a
  dispute with a **forged** `disputed_solver_id` → stored row stamps `S` = the report's
  `resolved_by`, client value ignored), SCEN-002 (resolve a visible report → `resolved_count`
  +1, read from `solver_profiles`), SCEN-003 (uphold → `upheld_count` +1, `resolved_count`
  unchanged), SCEN-004 (revert → `reverted_count` +1, `resolved_count` −1), SCEN-005
  (staff-resolved report disputed+reverted → every `solver_profiles` row's counts unchanged),
  SCEN-009 **primary sort only** (an `ORDER BY reverted_count DESC` query returns the
  higher-`reverted_count` solver first — the reliability tiebreak is a JS post-fetch concern
  tested in C3.2 vitest, NOT here, since `solver_profiles` has no reliability column),
  SCEN-010 (anon SELECT on `solver_profiles` returns the counts; anon SELECT on
  `report_disputes` → **0 rows**). Assert counts by **reading the columns** (B3.3
  false-green lesson), never by recomputing. Capture `get_advisors security` **before** the
  migration as the baseline. Run `supabase test db` until green on a fresh stack.
  - **Accept**: `solver_reputation_test.sql` passes on a fresh `supabase db reset` stack;
    `get_advisors security` diffed against the captured baseline shows the **only** delta is
    zero new anon-EXECUTE warnings (0028/0029 unchanged) and no new missing-RLS — an
    observed before/after artifact, not an assertion.
- [ ] **C1.3 — Apply `0019` to remote** + re-run pgTAP via MCP `execute_sql`
  (`num_failed = 0`).
  - **Accept**: remote migration listed; remote pgTAP `num_failed = 0`; remote
    `get_advisors` baseline unchanged.

## Chunk C2: Reliability service + count fields

Wires the read path. Satisfies SCEN-006 and the service half of SCEN-007/008.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `src/lib/reputation/reliability.ts` | NEW | `reliability(resolved, reverted): number \| null` → round-half-up integer percent, or `null` when `resolved + reverted = 0` (the view renders "Sin historial aún" for `null`) — the single place the formula + rounding live |
| `src/lib/services/solverService.ts` | MOD | `SolverProfile += resolvedCount, upheldCount, revertedCount`; `getSolverProfileByHandle` select `+ resolved_count, upheld_count, reverted_count`; `SolverProfileRow` + mapping |
| `src/lib/services/reportDetailService.ts` | MOD | `SolverAttribution += resolvedCount`; the existing `solver_profiles` lookup select (`id, handle, type, avatar_url`) `+ resolved_count`; map into the attribution |
| `*.test.ts` beside `reliability` + services | NEW | unit tests |

### Steps
- [ ] **C2.1 — `reliability` helper** | Size: S | Deps: C1.3 — pure function; vitest covers
  SCEN-006: `(47, 2) → 96`, `(n, 0) → 100`, `(0, 0) → null` (never `0`/`NaN`), and the
  round-half-up `.5` boundary (e.g. a ratio landing on `x.5%` rounds up deterministically).
  - **Accept**: `reliability.test.ts` green; the empty case returns `null`, not 0; rounding
    is round-half-up and deterministic.
- [ ] **C2.2 — Count fields on read services** | Size: M | Deps: C1.3 — `solverService`
  exposes the three counts on `SolverProfile`; `reportDetailService` exposes `resolvedCount`
  on `SolverAttribution` (one-column add to the existing `solver_profiles` select). vitest
  asserts the new fields map correctly (service half of SCEN-007/008).
  - **Accept**: service tests assert the three counts on `SolverProfile` and `resolvedCount`
    on `SolverAttribution`; existing solver/detail tests still green.

## Chunk C3: UI — profile reputation block, detail badge, admin signal

Surfaces reputation. Satisfies the UI half of SCEN-007, 008, 009.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `src/components/solver/ReputationBlock.tsx` | NEW | presentational block: "N resueltos · M sostenidas en disputa · K revertidas — X% de fiabilidad" (copy signals upheld ⊂ resolved); "Sin historial aún" when the reliability sentinel; uses the C2 helper |
| `src/app/(public)/solucionadores/[handle]/page.tsx` | MOD | render `ReputationBlock` in `ProfileHeader` from the new `SolverProfile` counts |
| `src/app/(public)/reportes/[id]/page.tsx` | MOD | `AttributionBadge` shows "· N resueltos" from `SolverAttribution.resolvedCount` |
| `src/components/panel/SolverReputationList.tsx` | NEW | admin section rows: handle + three counts + reliability |
| `src/app/(panel)/panel/page.tsx` | MOD | admin-gated query `solver_profiles` ordered `reverted_count DESC` (reliability secondary, derived per-row); render "Solucionadores" section — mirrors the "Disputas abiertas" admin-only pattern already present |
| `src/app/globals.css` | MOD | `.solver-reputation*` |
| `*.test.tsx` beside components | NEW | component tests |

### Steps
- [ ] **C3.1 — `ReputationBlock` + detail badge enrichment** | Size: M | Deps: C2.2 —
  the profile block renders the three counts + reliability (and the "Sin historial aún"
  empty state) using the C2 helper (SCEN-007); the detail `AttributionBadge` shows
  "· N resueltos" (SCEN-008). Copy signals that "sostenidas" is a subset of "resueltos"
  (reviewer note; final wording via `/humanizer`).
  - **Accept**: component tests green (block renders counts/rate + empty state; badge shows
    `resolvedCount`); `resolved_count` shown equals the wall the page already lists — it
    counts *rows*, not thumbnails (a card renders even when both thumbs fail to mint), so the
    match is row-count == `resolved_count`, never "fix" it to thumbnail count.
- [ ] **C3.2 — Admin "Solucionadores" panel section** | Size: M | Deps: C2.2 — add an
  admin-gated query (only when `isAdmin(role)`, mirroring the disputes section; reuse the
  request-bound **authenticated** `supabase` client already in scope — `solver_profiles` is
  world-readable, so no service-role client) reading `solver_profiles` ordered
  `reverted_count DESC` **at the DB**; derive reliability per-row (C2 helper) and apply it as
  the secondary sort **in JS post-fetch** (the DB cannot sort by the derived rate); render
  `SolverReputationList` (SCEN-009). Non-admin staff see no section.
  `tsc`/`eslint`/`vitest`/`next build` green.
  - **Accept**: build green; `/panel` shows the section for admin only, higher-`reverted_count`
    solver first; non-admin sees nothing; component/vitest test covers the JS reliability
    tiebreak (the DB can't) **and** admin gating.

## Chunk C4: Runtime verification (agent-browser, local stack)

Closes the UI/runtime scenarios (SCEN-007/008/009) end-to-end, with DB spot-checks of the
002/003/004 count effects. The pure-DB scenarios (SCEN-001/005/010) are fully covered by
C1.2 pgTAP and not re-run in the browser. No new code unless a scenario fails.

### Steps
- [ ] **C4.1 — Runtime SCEN-007/008/009 (+ DB spot-check 002/003/004)** | Size: M | Deps:
  C3.2 — local stack ([[local-stack-runtime-qa]] recipe — mind the
  **localhost-not-127.0.0.1** hydration block and the **native `.click()`** gotcha): seed a
  verified solver `S`, resolve a visible report (DB: `resolved_count` rises — SCEN-002),
  file + **uphold** a dispute (DB: `upheld_count` +1, `resolved_count` steady — SCEN-003),
  file + **revert** another (DB: `reverted_count` +1, `resolved_count` −1 — SCEN-004); then
  observe `/solucionadores/[handle]` reputation block (counts + rate, count == wall —
  SCEN-007), the report detail attribution badge "· N resueltos" (SCEN-008), and the
  `/panel` "Solucionadores" ordering as admin (SCEN-009). Console clean, zero failed
  requests.
  - **Accept**: each listed scenario observed in the browser with DB confirmation;
    console/network clean. Then `/verification-before-completion` gate.

## Testing strategy

- **pgTAP** (C1): SCEN-001..005, 009 (`reverted_count DESC` primary sort only), 010 — stamp
  (incl. forged-value overwrite), resolve/uphold/revert count math read from the column,
  staff-resolved no-op, anon RLS (counts public / disputes admin-only / 0 rows). Advisors
  before/after diff: no new anon-EXECUTE.
- **vitest** (C2/C3): `reliability` (formula, 100%, empty → `null`, round-half-up — SCEN-006),
  `solverService`/`reportDetailService` count fields, `ReputationBlock`, the detail badge,
  `SolverReputationList` (the JS reliability tiebreak — which pgTAP can't test — + admin gating).
- **Runtime agent-browser** (C4): SCEN-007/008/009 on a local stack, with DB confirmation of
  the 002/003/004 count effects.

## Rollout

- `0019` applies cleanly from `0018`; additive only — `report_disputes` gains one nullable
  column (stamped by trigger; the existing `return=minimal` insert is unchanged),
  `solver_profiles` gains three counts (backfilled in-migration). No change to
  `resolve_dispute`, `change_report_status`, `reports_in_view`, or the public map/visibility
  path.
- DB-first per the cross-chunk rule: migrate + pgTAP + advisors green → then app code.
  `db.yml` triggers on `supabase/migrations/**` + `supabase/tests/**`, so the pgTAP runs in
  CI. `ci.yml` runs lint/type/test/build/deploy on push. Push per explicit user authorization.
- Backfill consequence: existing solvers show counts computed from current data; historical
  `reverted` attribution is best-effort (near-certainly empty in prod). No reputation is
  retroactively invented — a deliberate, product-visible choice.
- Rollback: dropping `0019` removes the column + counts + triggers; the app code is additive
  (no existing read/write path changes), so reverting the app commits restores prior behavior.
