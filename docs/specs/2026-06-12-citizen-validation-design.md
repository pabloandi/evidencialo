---
title: Citizen validation / corroboration of reports (subsystem A)
date: 2026-06-12
status: draft
epic: "Citizen reporting → validation → resolution → reputation → incentives (4 subsystems: A validation, B solvers, C reputation, D donations)"
note: Subsystem A of the larger vision. B (solvers) is already shipped. This subsystem lets other citizens/witnesses corroborate that an ORIGINAL report is real — a trust signal that earns a "Corroborado" badge and feeds solver/staff prioritization. It does NOT gate publication and does NOT reorder the public map.
---

# Citizen validation / corroboration of reports (subsystem A)

## Problem

Today a citizen report publishes to the public map purely on media-sanitization
(`is_visible`) — no third party has vouched that the problem is real. There is no
signal that distinguishes a single unverified complaint from one a whole
neighborhood is living with, and no cheap defense against fabricated reports
beyond staff manually marking them `descartado`. The product vision treats
**validation** as the link between *reporting* and *resolution*: before a solver
invests effort, the crowd should be able to corroborate that a report is genuine
and how many people it affects.

## Goals

- Let other citizens/witnesses **corroborate** an original report ("yo también lo
  veo") to build trust and surface fake reports by their *absence* of corroboration.
- Earn a public **"Corroborado"** badge at a configurable threshold of verified
  (authenticated) confirmations.
- Feed a **prioritization** signal for solvers/staff (more corroborated → higher in
  the work queue), without touching the public map order.
- Reuse the existing anti-spam stack (Turnstile captcha + Upstash rate-limit +
  hashed-IP dedup) so anonymous corroboration is possible but hard to inflate.
- Lay clean data foundations for reputation (subsystem C).

## Non-goals (separate subsystems / future)

- Negative signals — "this is fake / duplicate / already fixed" voting → **not in
  this MVP** (staff `descartado` + subsystem B resolution disputes cover the rest).
- Gating publication on corroboration (crowd moderation) → explicitly rejected; a
  real report still publishes on media-sanitize.
- Reordering the **public** map/list by corroboration → out of scope (prioritization
  is for solvers/staff only).
- Reputation scores / leaderboards → **subsystem C**.
- Geolocation/proximity enforcement of the validator → rejected (spoofable, adds
  friction; anonymous weight is already reduced).

## Design

### Decisions locked in brainstorming

- **Purpose**: corroboration / trust (Q1).
- **Who validates**: hybrid — authenticated + anonymous, weighted differently. The
  report's author counts as an **implicit verified** validation (Q2).
- **Effect**: a **"Corroborado"** badge by threshold + feeds **solver/staff
  prioritization** (not public map order, not a publication gate) (Q3).
- **No negative signal** in MVP — positive-only "Confirmar" (Q4).
- **Anti-abuse**: hashed-IP dedup + captcha + rate-limit for anonymous; one per
  authenticated user per report; no proximity/GPS (Q5).
- **Trust model**: two visible counts (verified vs anonymous); badge at **verified
  ≥ 3** (author implicit = 1st verified); anonymous do NOT count toward the badge
  but DO feed priority at reduced weight (4 anon ≈ 1 verified) (Q6).
- **Surfaces**: "Confirmar" write-action only on the report detail; badge + counts
  travel read-only to detail, map popup, and lists (Q7).
- **Architecture**: denormalized counts maintained by a trigger; the public map
  read (`reports_in_view`) serves the counts without per-read aggregation (Enfoque 1).

### Data model (migration `0018`)

New table `public.report_validations`:

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK `default gen_random_uuid()` | |
| `report_id` | `uuid NOT NULL` → `reports(id) ON DELETE CASCADE` | |
| `validator_id` | `uuid NULL` → `auth.users(id) ON DELETE SET NULL` | set for AUTHENTICATED (= `auth.uid()`); null for anonymous. FKs `auth.users` to match the actor-who-acted convention (`reports.reporter_id`, `report_disputes.created_by`) |
| `ip_hash` | `text NULL` | set for ANONYMOUS (hashed client IP), null for authenticated |
| `created_at` | `timestamptz NOT NULL default now()` | |

- **Verified vs anonymous is derived** from `validator_id IS NOT NULL` — no
  redundant `is_verified` column.
- Constraint `report_validations_identity_chk`:
  `(validator_id IS NULL) <> (ip_hash IS NULL)` — exactly one identity present.
- Dedup (partial unique indexes):
  - `report_validations_one_per_user (report_id, validator_id) WHERE validator_id IS NOT NULL`
  - `report_validations_one_per_ip (report_id, ip_hash) WHERE ip_hash IS NOT NULL`
- `report_validations_report_idx (report_id)`.

`reports` gains denormalized aggregates:

- `verified_count int NOT NULL DEFAULT 0`
- `anon_count int NOT NULL DEFAULT 0`
- `priority_score int GENERATED ALWAYS AS (verified_count + anon_count / 4) STORED`
  — the anonymous weight (`/4`, integer division) lives here; used for the
  solver/staff queue ordering. Precedence makes this `verified_count +
  (anon_count / 4)`; integer division **floors** the anon contribution (4 anon →
  +1, 3 anon → +0), so sub-threshold anon counts add 0 to priority — intended, not
  a rounding bug. The badge **threshold** lives in app config (it is tuned more
  often than the weight); see Read path. (A STORED generated column referencing
  sibling columns in the same table is valid in Postgres 17.)

### Write path

`validate_report(p_report_id uuid, p_ip_hash text) RETURNS TABLE(verified_count int, anon_count int, newly_added boolean)` —
`SECURITY DEFINER`, `search_path = ''`:

1. Identity: if `auth.uid()` is non-null → a **verified** row (`validator_id =
   auth.uid()`, `ip_hash = NULL`); else → an **anonymous** row (`validator_id =
   NULL`, `ip_hash = p_ip_hash`, which must be non-empty → else `22023`).
2. Validatability gate: the target report must exist with `status IN
   ('nuevo','en_proceso') AND is_visible` → else `raise P0001` (mapped to 409
   not-validatable).
3. `INSERT … ON CONFLICT DO NOTHING` against the partial-unique dedup indexes;
   `newly_added` = whether a row was inserted (idempotent re-confirm → `false`).
4. Returns the **fresh** `verified_count` / `anon_count` (read from `reports`
   after the count trigger fires) so the client updates immediately.
5. `REVOKE EXECUTE ON FUNCTION validate_report(uuid, text) FROM public;`
   `GRANT EXECUTE ON FUNCTION validate_report(uuid, text) TO authenticated, anon;`
   — granted **by full signature**. Anon EXECUTE is intentional (anonymous
   corroboration); the captcha + rate-limit gates live in the API route, not the DB.

Direct client INSERTs into `report_validations` are NOT permitted (no INSERT RLS
policy) — the RPC is the only **client** write path. (The author-seed and recount
triggers also write to the table, but as `SECURITY DEFINER`, bypassing RLS.) The
RPC returning counts read from `reports` (never the validation row via
`INSERT … RETURNING`) sidesteps the restrictive-SELECT-policy trap that bit
subsystem B.

API route `POST /api/reports/[id]/validate` (Node.js runtime — supabase-js is not
Edge-compatible). Gate order mirrors `POST /api/reports/[id]/dispute`:

1. uuid check → 400.
2. resolve session (throw degrades to anonymous).
3. **rate-limit** (key by `user:<id>` else `ip:<hash-input>`; fails open).
4. **captcha for anonymous only** (`cf-turnstile-response` header; fails closed →
   403 `captcha_required` / `captcha_invalid`).
5. compute `ip_hash` for anonymous (hash of the trailing-hop client IP via the
   shared `clientIp` helper).
6. call `validate_report`; map: `newly_added` → 201; idempotent (already
   validated) → 200; P0001 not-validatable → 409; 22023 → 400; else 500. Response
   body carries `{ verified_count, anon_count, corroborated }`.

### Read path

- **Count trigger** `report_validations_recount` (`AFTER INSERT OR DELETE` on
  `report_validations`, `SECURITY DEFINER`, `search_path=''`): recomputes
  `reports.verified_count` / `anon_count` for the affected report from scratch
  (recompute philosophy, mirroring the visibility trigger) — robust against any
  insert/delete path. **Terminates (no cycle)**: it fires on `report_validations`
  and only `UPDATE`s `reports`; that `UPDATE` fires the existing
  `reports_set_updated_at` BEFORE trigger (harmless) but no validation trigger, so
  the chain `INSERT reports → seed → INSERT report_validations → recount → UPDATE
  reports` ends there.
- **Author implicit validation**: trigger `reports_seed_author_validation`
  (`AFTER INSERT` on `reports`, `SECURITY DEFINER`, `search_path=''`): when
  `NEW.reporter_id IS NOT NULL`, insert a verified validation row for the author →
  the recount trigger then sets `verified_count = 1`. Anonymous reports (no
  `reporter_id`) start at 0.
- `reports_in_view` **v3**: add `verified_count` and `anon_count` to the bbox read
  so the map popup can show counts + derive the badge. The view **stays
  `SECURITY INVOKER`** (as it has since `0010`) — only `validate_report` and the
  two triggers are DEFINER; the bbox read runs under the caller's RLS and
  `reports_select_public` (`is_visible = true`) already exposes the rows. Because
  adding return columns changes the `RETURNS TABLE` shape, shipping v3 is a
  `DROP FUNCTION IF EXISTS public.reports_in_view(...) ; CREATE FUNCTION ...` plus
  re-`REVOKE`/`GRANT` (anon, authenticated, service_role) — `CREATE OR REPLACE`
  cannot change a return type. Same mechanism the v2 used in `0015`.
- `reportDetailService`: expose `verifiedCount`, `anonCount`, `corroborated`
  (= `verifiedCount >= CORROBORATION_THRESHOLD`), and `hasValidated` (whether the
  current authenticated viewer already validated — via the SELECT-own policy). For
  anonymous viewers `auth.uid()` is null, so the policy returns nothing and
  `hasValidated` is always `false` → they always see "Confirmar" and the API is
  idempotent (correct, not a bug).
- **Config**: `CORROBORATION_THRESHOLD = 3` in a single module
  (`src/lib/validation/corroboration.ts` or similar). The badge is derived in the
  app layer from `verified_count`; the DB stores only raw counts. (The anon
  priority weight `/4` lives in the `priority_score` generated column.)
- **Solver/staff prioritization**: the `/panel` open-reports list orders by
  `priority_score DESC` and shows the counts. (Public map order is unchanged.)

### UI

- `ValidationControl` (client) on the report detail, shown only when the report is
  validatable: "Confirmar — yo también lo veo" + the two counts + a "Corroborado ✓"
  badge once the threshold is met; reuses `TurnstileWidget` (from B) for anonymous
  callers; POSTs to the validate route; on success updates counts from the response
  and switches to a "Ya confirmaste" / disabled state. Spanish copy, `role="status"`
  / `role="alert"` like the dispute form.
- Read-only `CorroboratedBadge` + counts on: detail header, map popup (HTML built
  app-side and HTML-escaped, like B's attribution), and lists (my-reports / panel).

### Authz / RLS / abuse

- `report_validations` RLS enabled, with the project's "grants gate verbs, RLS
  gates rows" posture (as in `0003`/`0014`): `GRANT SELECT … TO anon,
  authenticated` and deliberately **withhold INSERT/UPDATE/DELETE** from clients
  (only the DEFINER RPC/triggers write). **No INSERT policy.** SELECT policies:
  `report_validations_select_own USING (validator_id = (select auth.uid()))` for the
  "did I validate" check, plus `report_validations_select_admin USING
  (private.is_admin())` for moderation. An anonymous caller (`auth.uid()` null, not
  admin) matches no SELECT policy → sees **0 rows** (cannot enumerate). No client
  UPDATE/DELETE.
- Anonymous corroboration: captcha + rate-limit + hashed-IP dedup (one per IP per
  report). Authenticated: one per user per report. Author re-confirm is a no-op
  (dedup). Anonymous confirmations never move the badge (sockpuppet-resistant);
  they only feed `priority_score` at reduced weight.
- The DEFINER RPC + count/seed triggers use `search_path=''` and fully-qualified
  names, following the project's hardened-DEFINER convention.

## Observable scenarios (SDD holdout)

- **SCEN-A-001 (verified confirm)** — Given a visible `nuevo` report authored by an
  authenticated user (`verified_count = 1`), when a *different* authenticated user
  confirms it, then a `report_validations` row exists for that user and
  `verified_count = 2`.
- **SCEN-A-002 (badge threshold)** — Given a report with `verified_count = 2`, when
  a 3rd distinct authenticated user confirms, then `verified_count = 3` and the
  report is `corroborated` (badge shown).
- **SCEN-A-003 (anonymous confirm + weight)** — Given a visible report, when an
  anonymous visitor (captcha ok) confirms, then `anon_count` increments,
  `verified_count` is unchanged, and `priority_score = verified_count +
  anon_count / 4`.
- **SCEN-A-004 (idempotent dedup)** — Given a user (or IP) already confirmed a
  report, when they confirm again, then no new row is added, the counts are
  unchanged, and the API responds 200 (not 201).
- **SCEN-A-005 (not validatable)** — Given a `resuelto`, `descartado`, or hidden
  report, when anyone tries to confirm, then it is rejected (409) and no row is
  added.
- **SCEN-A-006 (author implicit)** — Given an authenticated user creates a report,
  then a verified validation row for the author exists and `verified_count = 1`
  immediately; an anonymous report starts at `verified_count = 0`.
- **SCEN-A-007 (read surfaces)** — Given a report with counts, when it is read via
  `reports_in_view` (map bbox) and the detail page, then `verified_count` /
  `anon_count` and the derived badge are present.
- **SCEN-A-008 (RLS privacy)** — A non-admin cannot read another user's validation
  rows and cannot insert a `report_validations` row directly (only the RPC writes);
  an anonymous client cannot enumerate the table.
- **SCEN-A-009 (anti-abuse)** — An anonymous confirm without a valid captcha is
  rejected (403); the endpoint is rate-limited (429); a verified author cannot
  inflate `verified_count` by re-confirming (dedup).
- **SCEN-A-010 (priority ordering)** — Given two open reports with different
  `priority_score`s, when staff view the panel queue, then the reports are ordered
  by `priority_score DESC`.

## Testing strategy

- **pgTAP** (`report_validations_test.sql`): table + identity check + dedup unique
  indexes; `validate_report` (verified path, anonymous path, idempotent re-confirm,
  not-validatable rejection, empty ip_hash → 22023); author-seed trigger; recount
  trigger correctness; `priority_score` math (assert by **reading the column** from
  `reports`, not recomputing — the B3.3 false-green lesson); `reports_in_view` v3
  counts; RLS (select-own, admin-all, anon SELECT returns **0 rows**, no direct
  client insert). Include a guard for the non-admin RPC return path.
- **vitest**: `validationService` (RPC result/error mapping), the validate route
  (every gate: rate-limit, captcha-anon, not-validatable, idempotent, success),
  `ValidationControl`, and the read-service count fields.
- **Runtime (agent-browser, local stack)**: authenticated confirm → `verified_count++`
  and badge appears at 3; anonymous confirm → `anon_count++`; second confirm is
  idempotent; badge visible in the map popup; console clean.

## Implementation chunks

- **A1** — migration `0018` (`report_validations` + `reports` aggregate columns +
  `validate_report` RPC + recount/seed triggers + `reports_in_view` v3 + RLS) +
  `report_validations_test.sql` pgTAP.
- **A2** — application layer: `corroboration` config, `validationService`,
  `POST /api/reports/[id]/validate`, read-service count/badge fields + vitest.
- **A3** — UI: `ValidationControl`, `CorroboratedBadge`, detail + map popup + panel
  wiring + vitest.
- **A4** — runtime verification (agent-browser, local stack) closing the scenarios.

## Files / migrations / blast radius

- **NEW**: `supabase/migrations/0018_report_validations.sql`,
  `supabase/tests/report_validations_test.sql`,
  `src/lib/validation/corroboration.ts`, `src/lib/services/validationService.ts`
  (+ test), `src/app/api/reports/[id]/validate/route.ts` (+ test),
  `src/components/report/ValidationControl.tsx` (+ test),
  `src/components/report/CorroboratedBadge.tsx`.
- **MODIFIED**: `reports_in_view` (v3 — DROP+CREATE+re-grant, additive return
  columns; consumers `reportService`/map read), `reportDetailService` (+
  count/badge/hasValidated fields), `src/app/(public)/reportes/[id]/page.tsx`
  (render `ValidationControl` + badge), `src/components/map/MapView.tsx` + map popup
  HTML (badge/counts), `src/app/(panel)/panel/page.tsx` (order by `priority_score`,
  show counts), `globals.css` (`.validation-control*` + `.corroborated-badge*`).
- **Blast radius note**: `reports_in_view` v3 is additive (new columns) — existing
  bbox consumers keep working; the map read gains two integer columns. No change to
  the publication/visibility path. `reports` row width grows by 3 columns.

## Rollout plan

- Migration `0018` applies cleanly from `0017` (disputes). `reports_in_view` v3 is
  a `DROP FUNCTION … ; CREATE FUNCTION …` + re-`GRANT` (adding return columns
  forbids `CREATE OR REPLACE`; same mechanism as v2 in `0015`) — the new columns
  are additive, existing bbox consumers keep working.
- Per-chunk: pgTAP + vitest + `next build` green, `/verification-before-completion`
  gate before each commit, push per explicit user authorization (the established
  cadence). CI: `db.yml` now triggers on `supabase/tests/**` too, so the pgTAP runs.
- Backfill: existing reports get `verified_count = 0` / `anon_count = 0` by default;
  the author-seed trigger is forward-only (does not retro-seed historical authors) —
  acceptable for MVP (no historical corroboration is claimed). Consequence: existing
  *authored* reports show `verified_count = 0` (no "Corroborado" badge) until
  re-corroborated — a deliberate, product-visible choice, not a bug.
