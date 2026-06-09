---
title: Solvers + public resolution attribution (subsystem B)
date: 2026-06-08
status: draft
epic: "Citizen reporting → validation → resolution → reputation → incentives (4 subsystems: A validation, B solvers, C reputation, D donations)"
note: Subsystem B of the larger vision. A/C/D are separate specs. This one opens the existing staff-only status workflow to verified "solvers" (government / influencers / orgs) who claim and resolve reports with public proof + attribution, laying the data foundation for reputation (C) and donations (D).
---

# Solvers + public resolution attribution (subsystem B)

## Problem

evidencialo turns citizen complaints into a public map, but **resolution is invisible
and internal**: only `staff` can change a report's status (`change_report_status`, gated
by `private.is_staff()`), and there is no public record of *who* fixed a problem or
*proof* that it was fixed. The product vision is a map of **solutions**, not just
complaints: local government and influencers should be able to claim a report, fix it,
prove it, and get **public credit** — which later fuels reputation (subsystem C) and
incentives/donations (subsystem D).

## Goals

- A verified **solver** actor (admin-curated) — government, influencer, or org — distinct
  from internal staff.
- Solvers **claim** a report (→ `en_proceso`, soft, no lock) and **resolve** it
  (→ `resuelto`) with **proof media** (photos AND videos), reusing the existing media
  sanitization pipeline.
- **Public attribution**: "En proceso por @X" / "Resuelto por @X" on the report detail
  and map, plus a public solver profile page listing their resolved reports.
- Works with the **anonymous-majority** reality of reports (no dependency on the original
  reporter to confirm).
- A lightweight **dispute** path so a false/abusive resolution can be flagged and reverted.

## Non-goals (separate subsystems / future)

- Reputation scores, leaderboards, ranking math → **subsystem C**.
- Donations / payments / payouts → **subsystem D**.
- Citizen/witness validation of the *original report* → **subsystem A**.
- Geographic/category scoping of solvers (Alcaldía de Cali → only Cali) → **fast-follow**;
  MVP is global (curation controls abuse).
- Self-service solver onboarding → MVP is admin-curated only.

## Design

### Decisions locked in brainstorming
- **A: trust** — verified, admin-curated solvers only.
- **A: resolution** — proof (photo+video) → `resuelto` immediately + public dispute window
  (works with anonymous reports).
- **A: claim** — soft claim → `en_proceso`, no exclusive lock; the proof submitter gets
  resolution credit.
- **⚙️ scope** — global in MVP; **⚙️ dispute** — flag → admin review; **⚙️ data** — as below.

### Solver identity
- Extend `user_role` enum with **`solver`** (currently `citizen, staff, admin`).
- New table **`public.solver_profiles`** (1:1 with `profiles`):
  - `id uuid PK REFERENCES profiles(id) ON DELETE CASCADE`
  - `handle citext UNIQUE NOT NULL` (e.g. `alcaldia-cali`) — used in `/solucionadores/[handle]`
  - `type text NOT NULL CHECK (type IN ('government','influencer','org'))`
  - `bio text NULL`, `avatar_url text NULL`
  - `links jsonb NOT NULL DEFAULT '{}'` (socials/donation links — forward-compat for D)
  - `verified_at timestamptz NOT NULL DEFAULT now()`, `verified_by uuid REFERENCES profiles(id)`
  - `created_at timestamptz NOT NULL DEFAULT now()`
- **Admin grants** by setting `profiles.role = 'solver'` AND inserting a `solver_profiles`
  row. Both via an admin-only RPC `grant_solver(...)` (SECURITY DEFINER, `is_admin()` gate)
  to keep it atomic + audited; no self-service.
- `private.is_solver()` helper (mirrors `private.is_staff()`): true when the caller's
  `profiles.role = 'solver'`.

### Resolution lifecycle (reuses `report_status`)
```
nuevo ──(solver claims)──► en_proceso ──(solver submits proof)──► resuelto
  └───────────────(solver resolves directly, with proof)───────────┘
resuelto ──(anyone disputes)──► [admin review] ──► upheld (stays) | reverted (→ en_proceso, attribution stripped)
descartado ← (staff/admin only, unchanged)
```
- **Claim**: `nuevo|en_proceso(other)` → `en_proceso`, sets `reports.claimed_by = auth.uid()`,
  `claimed_at = now()`. Soft — re-claim by another solver overwrites `claimed_by` (the
  "currently working" signal); no lock.
- **Resolve**: `→ resuelto` REQUIRES ≥1 `resolution` proof media already attached and
  processed; sets `reports.resolved_by = auth.uid()`, `resolved_at = now()`.
- Implemented by **extending `change_report_status`** (keep its DEFINER, `for update` lock,
  no-op guard, `report_status_history` audit insert). New gate: allow `solver` for
  `en_proceso`/`resuelto` transitions (capturing claimed_by/resolved_by); `descartado`
  stays staff/admin-only; staff/admin retain all powers. The `→ resuelto` path raises
  (e.g. `P0001`) if no processed proof media exists.

### Proof media (photos + videos)
- Add **`kind`** to `public.report_media`: `text NOT NULL DEFAULT 'report' CHECK (kind IN ('report','resolution'))`.
  Existing rows backfill to `'report'`.
- Resolution proof reuses the **exact** capture→upload→`/api/media`→`sanitize-video`
  pipeline (EXIF/GPS stripped) but tagged `kind='resolution'` and `uploaded_by = solver`.
  A new `POST /api/reports/[id]/resolution-media` (solver-gated) mints signed uploads for
  proof, mirroring `POST /api/reports`'s media contract.
- The public detail shows **before/after**: `kind='report'` media vs `kind='resolution'`
  media.

### Public attribution
- Report detail (`/reportes/[id]`) and map popup: badge **"En proceso por @handle"** /
  **"Resuelto por @handle"** with avatar + a type chip (✓ Gobierno / ✓ Influencer / ✓ Org),
  linking to `/solucionadores/[handle]`.
- New public page **`/solucionadores/[handle]`** (RSC, admin client, read-only): solver
  display name/handle/type/bio/avatar + a list of their `resuelto` reports (before/after
  thumbnails). This is the visibility surface and the seed for subsystem C.
- Read path: a SECURITY INVOKER view or read RPC exposing public solver fields +
  resolved-report join (no PII beyond public solver profile).

### Disputes
- New table **`public.report_disputes`**: `id`, `report_id` FK, `reason text`,
  `created_by uuid NULL` (anonymous allowed), `created_at`, `status text CHECK (status IN
  ('open','upheld','reverted')) DEFAULT 'open'`, `reviewed_by uuid NULL`, `reviewed_at`.
- Action "Reportar resolución falsa" on a `resuelto` report → inserts an `open` dispute
  (rate-limited, captcha for anonymous — reuse existing gates). Admin reviews in `/panel`:
  **uphold** (status→upheld, report stays `resuelto`) or **revert** (status→reverted,
  report → `en_proceso`, `resolved_by`/`resolved_at` cleared, attribution stripped) via the
  audited `change_report_status` + a dispute-resolution RPC.

### Data model summary
- `user_role` += `solver`.
- `solver_profiles` (new).
- `reports` += `claimed_by uuid NULL REFERENCES profiles(id)`, `claimed_at timestamptz NULL`,
  `resolved_by uuid NULL REFERENCES profiles(id)`. (`resolved_at` already exists.)
- `report_media` += `kind` (`report`|`resolution`), `uploaded_by uuid NULL`.
- `report_disputes` (new).
- RPCs: `grant_solver` (admin), extended `change_report_status` (solver transitions +
  proof requirement), `resolve_dispute` (admin). All DEFINER, `revoke from public, anon`,
  granted to the right roles by name (avoid the Supabase default-EXECUTE-to-anon trap).

### Authz / RLS / abuse
- `solver` can ONLY claim/resolve (not `descartado`), and sets `claimed_by`/`resolved_by`
  to **self** (the RPC uses `auth.uid()`, never a client-supplied id — no attributing to
  others).
- `→ resuelto` rejected without processed proof media (no empty "resolved" claims).
- `solver_profiles`: public read of display fields; writes admin-only (RPC).
- `report_disputes`: insert open to authenticated + captcha'd anonymous (rate-limited);
  read/resolve admin-only.
- Proof media sanitized (EXIF/GPS) like all media; signed uploads server-issued.
- Dispute spam: rate-limit + one open dispute per (report) coalesced.

## Observable scenarios (SDD holdout)
> File: `docs/specs/2026-05-31-stack-arquitectura/scenarios/solver-resolution.scenarios.md`

- **SCEN-001 (E1 — claim):** Given a verified solver and a `nuevo` report, when they claim
  it, then the report is `en_proceso` with `claimed_by = solver` and the detail/map show
  "En proceso por @handle".
- **SCEN-002 (E1 — resolve with proof):** Given a solver on a report with ≥1 processed
  `resolution` media, when they mark it resolved, then status is `resuelto`,
  `resolved_by = solver`, `resolved_at` set, an audit row is written, and the detail shows
  before/after + "Resuelto por @handle".
- **SCEN-003 (proof required):** Given a solver on a report with NO processed resolution
  media, when they try to resolve, then the RPC raises and the status stays unchanged.
- **SCEN-004 (authz):** Given a `citizen` (or anonymous), when they call claim/resolve,
  then it is rejected (42501) and nothing changes; given a `solver`, when they try
  `descartado`, then it is rejected (staff/admin-only).
- **SCEN-005 (anonymous report resolvable):** Given a `resuelto` flow on a report whose
  `reporter_id` is null, when the solver resolves with proof, then it succeeds with no
  dependency on the reporter.
- **SCEN-006 (no self-attribution forgery):** Given a solver, when the RPC sets
  `resolved_by`, then it equals `auth.uid()` regardless of any client-supplied value.
- **SCEN-007 (dispute revert):** Given a `resuelto` report, when a dispute is filed and an
  admin reverts it, then the report returns to `en_proceso`, `resolved_by`/`resolved_at`
  are cleared, the attribution disappears, and the audit trail records the revert.
- **SCEN-008 (solver profile page):** Given a solver with resolved reports, when anyone
  opens `/solucionadores/[handle]`, then it lists their `resuelto` reports with before/after
  and no PII beyond the public profile; an unknown handle 404s.
- **SCEN-009 (runtime, web):** Given a verified solver session, when they claim → upload
  proof → resolve via the UI, then the report shows resolved + attribution on the public
  map/detail, console clean, no failed requests.

## Testing strategy
- **pgTAP** for the DB contract: `change_report_status` solver transitions, proof
  requirement (raise), self-attribution via `auth.uid()`, grant/revoke (no anon EXECUTE),
  dispute revert, RLS on `solver_profiles`/`report_disputes`. (Mirrors existing
  `change_report_status_test.sql` style with `set local role` + jwt claims.)
- **Unit/integration** (vitest): the resolution-media API, the solver gating in the status
  API, the solver profile read service, before/after rendering.
- **Runtime** (agent-browser): SCEN-009 with a seeded verified solver on prod/preview.

## Files / migrations / blast radius
- **Migrations (new)**: enum `solver`; `solver_profiles`; `reports` columns; `report_media.kind`
  + backfill; `report_disputes`; `private.is_solver()`/`is_admin()`; `grant_solver`;
  `change_report_status` v2 (solver transitions + proof gate); `resolve_dispute`; RLS
  policies; grants. Plus pgTAP test files.
- **New routes/UI**: `POST /api/reports/[id]/resolution-media`, solver claim/resolve actions
  (extend `/api/reports/[id]/status` or a sibling), `/solucionadores/[handle]` page, solver
  controls on the report detail, "Reportar resolución falsa" action, admin dispute review in
  `/panel`, attribution badges on detail + `MapView` popup.
- **Modified**: `change_report_status` consumers; report detail service (before/after +
  attribution); `reportLabels`; panel.
- **Consumers**: public detail, map, panel, capture/media pipeline.
- **Backend contract**: this is the first subsystem to add real schema — multiple
  migrations applied to the remote project (sequence carefully; backfill `report_media.kind`
  before adding the NOT NULL/CHECK).

## Rollout plan
- Ship behind the existing auto-deploy. Apply migrations to the remote Supabase project
  **before** the app code that calls the new RPCs (same discipline as the earlier
  named-param RPC incident — migrate first, then deploy).
- Seed one verified solver (admin RPC) to validate SCEN-009 on prod.
- Rollback: revert the feature commit(s); migrations are additive (new tables/columns/enum
  value) — a down-migration drops the new objects; `report_media.kind` default keeps old
  reads working.
