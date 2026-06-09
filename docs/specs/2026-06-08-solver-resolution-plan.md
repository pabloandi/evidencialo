---
title: Implementation plan — solvers + public resolution attribution (subsystem B)
date: 2026-06-08
spec: docs/specs/2026-06-08-solver-resolution-design.md
scenarios: docs/specs/2026-05-31-stack-arquitectura/scenarios/solver-resolution.scenarios.md
---

# Implementation plan — subsystem B

Holdout: SCEN-001..010 (committed before code). Three independently-shippable chunks,
each migrated to the remote Supabase project **before** the app code that calls the new
RPCs, then deployed via the existing auto-deploy. Next migration number: **0013**.
pgTAP tests live in `supabase/tests/`.

Cross-chunk rule (DB discipline, from the named-param-RPC incident): apply migration →
verify with pgTAP + `get_advisors` (no anon EXECUTE / no RLS gaps) → THEN merge app code.

---

## Chunk B1: Solver identity & grant infra

No public behavior change. Foundation for B2/B3.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `…/scenarios/solver-resolution.scenarios.md` | NEW (done) | SDD holdout |
| `supabase/migrations/0013_solver_enum.sql` | NEW | `ALTER TYPE user_role ADD VALUE 'solver'` — ALONE (Postgres forbids using a new enum value in the same tx it's added; nothing else may reference the literal here) |
| `supabase/migrations/0014_solver_identity.sql` | NEW | `private.is_admin()` + `private.is_solver()` (per 0004 pattern); `solver_profiles` table + `unique(lower(handle))`; RLS (public read of display fields, no client writes); `grant_solver(p_user_id, p_handle, p_type, p_bio, p_avatar_url, p_links)` DEFINER, `private.is_admin()` gate, sets `role='solver'` + inserts profile; `revoke from public, anon` + grant authenticated |
| `supabase/tests/solver_identity_test.sql` | NEW | pgTAP: SCEN-010 (admin grant works, non-admin 42501, no anon EXECUTE, RLS) |

### Steps
**B1.1 — Holdout (done).** Size: S. Commit scenarios file before code.
**B1.2 — Enum migration.** Size: S. Deps: B1.1. Write `0013_solver_enum.sql` (enum add only). Apply to remote. Acceptance: `user_role` now includes `solver`; no other object references it yet.
**B1.3 — Identity migration + pgTAP (SCEN-010).** Size: M. Deps: B1.2. Write `0014` (helpers, `solver_profiles`, RLS, `grant_solver`) + `solver_identity_test.sql`. Apply to remote; run pgTAP; run `get_advisors`. Acceptance: pgTAP green (admin grant sets role+profile; non-admin raises 42501; grants show no anon/public EXECUTE; RLS denies client writes; **granting a user that has no `profiles` row fails cleanly — no orphan**, since `solver_profiles` FKs `profiles(id)` and profiles are created by `handle_new_user`); advisors clean. **Seed one verified solver** via `grant_solver` for later runtime tests.

---

## Chunk B2: Resolution lifecycle & attribution

The visible heart of B. Migrate first, then API, then UI.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `supabase/migrations/0015_solver_resolution.sql` | NEW | `reports` += `claimed_by/claimed_at/resolved_by`; `report_media` += `kind text default 'report'` then `not null` + `check(kind in ('report','resolution'))` (default backfills existing rows) + `uploaded_by uuid null`; **`report_media_visibility` trigger v2 — scope the is_visible recompute to `kind='report'` ONLY** (else attaching `pending` resolution proof un-publishes the report, permanently if a proof video fails); `change_report_status` v2 (`create or replace`, SAME signature, solver branch + proof gate `P0001`, attribution via `auth.uid()`); `attach_resolution_media(p_report_id, p_media[])` DEFINER solver-gated → signed uploads + `kind='resolution'` inserts; **`reports_in_view` v2 (`create or replace`, INVOKER) extended to return `claimed_by`/`resolved_by` handle+type** for the map popup (SCEN-001) — grants re-asserted, `reports_in_view_test.sql` updated for the new return shape; grants by name |
| `supabase/tests/solver_resolution_test.sql` | NEW | pgTAP: SCEN-001..006 |
| `supabase/tests/reports_in_view_test.sql` | MOD | update for the extended `reports_in_view` return shape (attribution columns) |
| `src/app/api/reports/[id]/resolution-media/route.ts` | NEW | solver-gated; mints signed uploads for proof media (mirrors `POST /api/reports` media contract) → `attach_resolution_media` |
| `src/app/api/reports/[id]/status/route.ts` | MOD | allow `solver` for claim/resolve (two-layer authz like the existing staff path); map proof-missing `P0001` → 422 |
| `src/lib/services/solverService.ts` | NEW | read public solver profile by handle + their resolved reports (admin client, public fields only) |
| `src/lib/services/reportDetailService.ts` | MOD | include claim/resolve attribution + before/after (`kind`) media in the detail payload |
| `src/app/(public)/reportes/[id]/page.tsx` | MOD | before/after section + "En proceso/Resuelto por @handle" badge |
| `src/components/capture/CaptureForm` pattern reuse | — | reuse the capture/upload client for proof upload (a `ResolutionUpload` client) |
| `src/components/solver/*` | NEW | solver controls (Reclamar / Subir prueba / Resolver) shown only to a solver session |
| `src/components/map/MapView.tsx` | MOD | popup shows "En proceso/Resuelto por @handle" badge (from the extended `reports_in_view`) |
| `src/app/(public)/solucionadores/[handle]/page.tsx` | NEW | public solver profile + resolved list (SCEN-008) |
| `src/lib/reportLabels.ts` | MOD | any new labels |

### Steps
**B2.1 — Resolution migration + pgTAP (SCEN-001..006).** Size: M. Deps: B1.3. Write `0015` + `solver_resolution_test.sql`. Sequence inside `0015`: add `report_media.kind` with default (backfills), then `not null`+`check`; then the visibility-trigger v2; then `reports_in_view` v2 (attribution columns) + update `reports_in_view_test.sql`. Apply to remote; pgTAP; advisors. Acceptance: pgTAP green — solver claim sets `claimed_by=auth.uid()` (SCEN-001); resolve requires processed proof else `P0001` (SCEN-003); resolve sets `resolved_by=auth.uid()`+audit (SCEN-002, 006); citizen/anon 42501 + solver→descartado 42501 (SCEN-004); null-reporter resolvable (SCEN-005); **attaching `pending` `kind='resolution'` media to a visible report leaves `is_visible=true`** (guards the trigger v2 — regression for blocker #1). NOTE: the existing no-op guard (`v_from = p_to_status → return`) means a second solver re-claiming an already-`en_proceso` report is a no-op; **MVP = first-claimer-wins** (`claimed_by` not overwritten on same-status re-claim). Re-claim-overwrite is a documented fast-follow (would need the solver claim branch to write `claimed_by` before the no-op guard).
**B2.2a — `attach_resolution_media` RPC + resolution-media route.** Size: M. Deps: B2.1. The RPC mints signed uploads on an EXISTING report (net-new path — `create_report` only mints at creation) + inserts `kind='resolution'` rows; the `POST /api/reports/[id]/resolution-media` route wraps it (solver-gated). Integration: solver uploads proof → `kind='resolution'` processed; non-solver 403. Acceptance: integration green.
**B2.2b — Solver gating in the status path + `authz.ts`.** Size: M. Deps: B2.1. **Add `solver` to `src/lib/services/authz.ts` (`AppRole`/`KNOWN_ROLES` + an `isSolver` predicate)** — without it a `solver` JWT claim normalizes to `null` (anonymous) and is rejected before the RPC. Then allow `solver` claim/resolve in `src/app/api/reports/[id]/status/route.ts` (two-layer authz), mapping proof-missing `P0001` → 422. Integration: solver claims/resolves via API; citizen 403; resolve-before-proof 422. Acceptance: integration green.
**B2.3 — Solver controls + before/after + attribution UI (detail + map).** Size: M. Deps: B2.2a, B2.2b. Solver-only claim/resolve controls on `/reportes/[id]`; before/after rendering; attribution badge on the **detail page AND the `MapView` popup** (SCEN-001 requires both). The map data comes from `reports_in_view`, extended in B2.1 to return the claim/resolve handle+type. Unit + agent-browser. Acceptance: a solver session sees controls; citizen does not; detail + map popup show "En proceso/Resuelto por @handle"; before/after render.
**B2.4 — `/solucionadores/[handle]` page (SCEN-008).** Size: M. Deps: B2.1. RSC listing the solver's resolved reports (before/after thumbs); unknown handle 404s; no PII. Unit/integration. Acceptance: SCEN-008 satisfied.
**B2.5 — Runtime verification (SCEN-009).** Size: S. Deps: B2.2a–B2.4 + deploy. Seeded solver session via agent-browser: claim → upload photo+video proof → resolve; verify resolved + attribution on detail/map, console clean, report row in DB. Then `/verification-before-completion` gate.

---

## Chunk B3: Disputes

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `supabase/migrations/0016_report_disputes.sql` | NEW | `report_disputes` table + **partial unique index `(report_id) where status='open'`** (coalesce: one open dispute per report) + RLS (insert: authenticated + captcha'd anon, rate-limited; read/resolve admin-only); `resolve_dispute(p_dispute_id, p_action)` DEFINER `private.is_admin()` — on `revert`: status→`en_proceso`, NULL `resolved_at`+`resolved_by`, audit row. **The nulling is done DIRECTLY in `resolve_dispute`, NOT via `change_report_status`** (which deliberately never clears `resolved_at`) |
| `supabase/tests/report_disputes_test.sql` | NEW | pgTAP: SCEN-007 (revert clears resolved_at/by + status) |
| `src/app/api/reports/[id]/dispute/route.ts` | NEW | file a dispute (reuse rate-limit + captcha gates) |
| `src/app/(public)/reportes/[id]/page.tsx` | MOD | "Reportar resolución falsa" action on `resuelto` reports |
| `src/app/(panel)/panel/*` | MOD | admin dispute review (uphold / revert) |

### Steps
**B3.1 — Disputes migration + pgTAP (SCEN-007).** Size: M. Deps: B2.1. Write `0016` + `report_disputes_test.sql`. `resolve_dispute` revert nulls `resolved_at`/`resolved_by` DIRECTLY (not through `change_report_status`). Apply to remote; pgTAP; advisors. Acceptance: revert nulls `resolved_at`/`resolved_by`, status→`en_proceso`, audit present; the partial unique index rejects a second open dispute on the same report; RLS correct.
**B3.2 — Dispute UI + admin review.** Size: M. Deps: B3.1. Dispute action (rate-limited + captcha for anon) + admin uphold/revert in `/panel`. Unit + integration. Acceptance: dispute files; admin revert strips attribution end-to-end.
**B3.3 — Runtime verification.** Size: S. Deps: B3.2 + deploy. agent-browser: file dispute → admin revert → attribution gone, status `en_proceso`. Verification gate.

---

## Testing strategy
- **pgTAP** is the primary contract gate for every migration (authz, proof gate, attribution via `auth.uid()`, grant/RLS, dispute revert) — mirror `change_report_status_test.sql`.
- **vitest** integration for the new API routes + services (real-dependency style where the repo already does, else mocked).
- **agent-browser** for SCEN-008/009 + B3 runtime, using the seeded solver.
- Regression: full `pnpm test` + advisors after each chunk; no anon EXECUTE on any new DEFINER fn.

## Rollout
- Per chunk: migrate remote → pgTAP + advisors green → merge app code → auto-deploy → runtime-verify on prod. Chunks ship in order B1 → B2 → B3.
- Rollback: additive migrations (new enum value/tables/columns) → down-migration drops new objects; `report_media.kind` default keeps old reads working; revert the chunk's app commit.
- Risk: the `user_role` enum value add (0013) is irreversible-ish (Postgres can't easily drop an enum value) — acceptable (additive, unused if rolled back).
