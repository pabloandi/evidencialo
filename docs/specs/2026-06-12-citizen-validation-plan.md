---
title: Implementation plan — citizen validation / corroboration (subsystem A)
date: 2026-06-12
spec: docs/specs/2026-06-12-citizen-validation-design.md
scenarios: docs/specs/2026-05-31-stack-arquitectura/scenarios/citizen-validation.scenarios.md
---

# Implementation plan — subsystem A

Holdout: SCEN-001..010 (committed before code) in `citizen-validation.scenarios.md`.
Four independently-shippable chunks. The migration is applied to the remote Supabase
project **before** the app code that calls the new RPC, then deployed via the existing
auto-deploy. Next migration number: **0018** (0017 = disputes). pgTAP lives in
`supabase/tests/`.

Cross-chunk rule (DB discipline, carried from subsystems A's siblings): apply migration
→ verify with pgTAP + `get_advisors` (no anon EXECUTE leak beyond the intended
`validate_report`; no RLS gaps) → THEN merge the app code that calls it. Per-chunk:
`tsc`/`eslint`/`vitest`/`next build` green + `/verification-before-completion` gate
before each commit; push only on explicit user authorization.

---

## Chunk A1: Validation data model, RPC, triggers, read view

Foundation. No public behavior change until A2/A3 surface it. Satisfies the DB half of
SCEN-001..008 and SCEN-010.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `…/scenarios/citizen-validation.scenarios.md` | NEW (done) | SDD holdout |
| `supabase/migrations/0018_report_validations.sql` | NEW | `report_validations` table (`validator_id → auth.users(id)`, `ip_hash`, identity XOR check, dedup partial-unique indexes); `reports +=` `verified_count`/`anon_count` + `priority_score` generated; `validate_report(uuid, text)` DEFINER `search_path=''`; `report_validations_recount` trigger (recompute); `reports_seed_author_validation` trigger; `reports_in_view` **v3** (DROP+CREATE+re-grant, stays INVOKER, +2 count columns); RLS (`grant select to anon, authenticated`; withhold I/U/D; `select_own` + `select_admin`; no insert policy) |
| `supabase/tests/report_validations_test.sql` | NEW | pgTAP for SCEN-001..008, 010 (DB) |

### Steps
- [ ] **A1.1 — Migration `0018`** | Size: L | Deps: none — author the table, `reports`
  columns, RPC, both triggers, `reports_in_view` v3, RLS/grants, exactly as the spec's
  Data model + Write/Read path sections. Apply to a **local** stack first (`supabase db
  reset`). **Fission point**: if this step runs long, the `reports_in_view` v3 rebuild
  (DROP+CREATE+re-grant) is the natural split — only A2's read-service and A3's map
  popup depend on it; the write path (table + RPC + triggers + RLS) does not. The
  migration otherwise ships as one transactional unit (atomic DDL).
- [ ] **A1.2 — pgTAP `report_validations_test.sql`** | Size: L | Deps: A1.1 — encode
  SCEN-001 (verified confirm → `verified_count=2`), 003 (anon confirm + weight; assert
  `priority_score` by reading the column), 004 (idempotent dedup adds 0 rows), 005
  (not-validatable raises, 0 rows), 006 (author-seed → `verified_count=1`; anon report
  → 0; an authored-report INSERT **completes** and lands at exactly 1 — locks the
  trigger cycle-termination invariant), 008 (select-own returns only caller rows,
  **anon SELECT → 0 rows**, direct client INSERT raises), 010 (`priority_score`
  ordering). Run `supabase test db` until green on a fresh stack; `get_advisors
  security` clean (only the intended `validate_report` anon EXECUTE).
  - **Accept**: `report_validations_test.sql` passes on a fresh `supabase db reset`
    stack; advisors show no unintended anon-EXECUTE / missing-RLS.
- [ ] **A1.3 — Apply `0018` to remote** + re-run pgTAP via MCP `execute_sql`
  (`num_failed=0`).
  - **Accept**: remote migration listed; remote pgTAP `num_failed = 0`.

## Chunk A2: Validation service + API + read fields

Wires the write path and exposes counts to the read services. Satisfies SCEN-009 and the
service/route half of SCEN-001..007.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `src/lib/validation/corroboration.ts` | NEW | `CORROBORATION_THRESHOLD = 3` + `isCorroborated(verifiedCount)` — the single config place |
| `src/lib/services/validationService.ts` | NEW | `validateReport(reportId, ipHash, client?)` → `rpc('validate_report', …)`; maps P0001→`ReportNotValidatableError`, 22023→`InvalidInputError`; returns `{ verifiedCount, anonCount, newlyAdded }` |
| `src/lib/http/ipHash.ts` | NEW | `ipHash(ip): string` — `sha256(IP_HASH_SALT + ip)` hex (node:crypto `createHash`); salt from required env `IP_HASH_SALT` (add to `src/lib/env.ts` + Vercel env). Unsalted hashing of the ~4B IPv4 space is brute-forceable, so the salt is mandatory for the privacy intent |
| `src/app/api/reports/[id]/validate/route.ts` | NEW | POST: uuid→400 · session (degrade anon) · rate-limit · captcha-anon · compute `ip_hash = ipHash(clientIp(request))` for anon · `validateReport` · map `newlyAdded`→201 / idempotent→200 / NotValidatable→409 / captcha→403 / rate→429 / 22023→400 / else 500 |
| `src/lib/services/reportDetailService.ts` | MOD | `+ verifiedCount, anonCount, corroborated, hasValidated` (select-own check) |
| `src/lib/services/reportService.ts` | MOD | `ReportMarker += verifiedCount, anonCount, corroborated` from `reports_in_view` v3 |
| `*.test.ts` beside service + route | NEW | unit/integration |

### Steps
- [ ] **A2.1 — `corroboration` config + `ipHash` helper + `validationService`** | Size: M
  | Deps: A1.3 — typed errors + RPC mapping; `ipHash` = `sha256(IP_HASH_SALT + ip)` hex
  with `IP_HASH_SALT` added to `env.ts`. Unit tests: service with a fake client (verified
  path, anon path, idempotent `newlyAdded=false`, P0001→NotValidatable); `ipHash`
  stability (same ip+salt → same hash) and salt-sensitivity (different salt → different
  hash). **Insert with the RPC only — never a client `.select()` on a table write**
  (B3.3 lesson).
  - **Accept**: `validationService.test.ts` + `ipHash.test.ts` green; mapping matches the
    RPC contract; `ipHash` is stable and salt-sensitive.
- [ ] **A2.2 — `POST …/validate` route** | Size: M | Deps: A2.1 — gate order mirrors the
  dispute route; SCEN-009: anon-without-captcha→403, rate-limited→429, author
  re-confirm→no-op; anon path passes `ipHash(clientIp(request))`.
  - **Accept**: route test covers every gate + 201/200/409; SCEN-009 assertions pass.
- [ ] **A2.3 — Read-service count fields** | Size: M | Deps: A1.3 — `reportDetailService`
  + `reportService` expose counts + derived `corroborated`; `hasValidated` false for anon.
  - **Accept**: read-service tests assert the new fields; `corroborated` uses
    `CORROBORATION_THRESHOLD`.

## Chunk A3: UI — confirm control, badge, panel ordering

Surfaces corroboration. Satisfies the UI half of SCEN-002, 007, 010.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `src/components/report/ValidationControl.tsx` | NEW | "Confirmar — yo también lo veo" + two counts + "Corroborado ✓" badge; `TurnstileWidget` only when anonymous; POST → update counts from response → "Ya confirmaste" |
| `src/components/report/CorroboratedBadge.tsx` | NEW | read-only badge + counts |
| `src/app/(public)/reportes/[id]/page.tsx` | MOD | render `ValidationControl` (when validatable) + badge |
| `src/components/map/MapView.tsx` + popup HTML | MOD | badge/counts in the popup (app-side, HTML-escaped) |
| `src/app/(panel)/panel/page.tsx` | MOD | order open reports by `priority_score DESC`; show counts |
| `src/app/globals.css` | MOD | `.validation-control*` + `.corroborated-badge*` |
| `*.test.tsx` beside components | NEW | component tests |

### Steps
- [ ] **A3.1 — `ValidationControl` + `CorroboratedBadge`** | Size: M | Deps: A2.2 —
  submit → mocked fetch → counts/badge update + error states; badge shows at threshold
  (SCEN-002).
  - **Accept**: component tests green (submit contract, success/error, badge threshold).
- [ ] **A3.2 — Detail + map popup + panel wiring** | Size: M | Deps: A3.1 — render
  control/badge on detail; popup shows badge/counts (SCEN-007); panel orders by
  `priority_score` (SCEN-010). The counts are injected into the hand-built popup HTML, so
  they MUST be HTML-escaped (carry B's attribution-escaping). `tsc`/`eslint`/`vitest`/
  `next build` green.
  - **Accept**: build green; `/reportes/[id]` + `/panel` + map render the new surfaces;
    counts in popup HTML are escaped (no raw interpolation).

## Chunk A4: Runtime verification (agent-browser, local stack)

Closes the scenarios end-to-end. No new code unless a scenario fails.

### Steps
- [ ] **A4.1 — Runtime SCEN-002/007/009/010** | Size: M | Deps: A3.2 — local stack
  ([[local-stack-runtime-qa]] recipe — mind the **localhost-not-127.0.0.1** hydration
  block and the **native `.click()`** gotcha): authenticated confirm → `verified_count++`,
  badge appears at 3 (SCEN-002); anonymous confirm → `anon_count++` (SCEN-009); second
  confirm idempotent (SCEN-004 runtime); badge in map popup (SCEN-007); panel ordering
  (SCEN-010); console clean, zero failed requests.
  - **Accept**: each listed scenario observed in the browser with DB confirmation;
    console/network clean. Then `/verification-before-completion` gate.

## Testing strategy

- **pgTAP** (A1): SCEN-001..008, 010 (DB) — counts, dedup, not-validatable, author-seed,
  RLS (select-own / anon-0-rows / no-direct-insert), `priority_score` read from column,
  `reports_in_view` v3, plus a non-admin RPC-return guard (B3.3 lesson).
- **vitest** (A2/A3): `validationService`, the validate route (all gates — SCEN-009),
  read-service count fields, `ValidationControl`/`CorroboratedBadge`.
- **Runtime agent-browser** (A4): SCEN-002/004/007/009/010 on a local stack.

## Rollout

- `0018` applies cleanly from `0017`; `reports_in_view` v3 is DROP+CREATE+re-grant
  (additive return columns). `reports` row width grows by 3 columns; existing rows
  default to `verified_count=0`/`anon_count=0` (no historical author backfill —
  forward-only, a stated product choice).
- DB-first per the cross-chunk rule: migrate + pgTAP + advisors green → then app code.
  `db.yml` now triggers on `supabase/tests/**`, so the pgTAP runs in CI. `ci.yml` runs
  lint/type/test/build/deploy on push. Push per explicit user authorization.
- Rollback: dropping `0018` removes the table + columns + RPC + triggers; the app code
  is additive (no existing read/write path changes), so reverting the app commits
  restores prior behavior.
