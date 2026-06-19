---
title: Implementation plan — donation channels (subsystem D)
date: 2026-06-18
spec: docs/specs/2026-06-18-donation-channels-design.md
scenarios: docs/specs/2026-05-31-stack-arquitectura/scenarios/donation-channels.scenarios.md
---

# Implementation plan — subsystem D

Holdout: SCEN-001..012 (committed before code) in `donation-channels.scenarios.md`.
Four independently-shippable chunks. The migration is applied to the remote Supabase
project **before** the app code that reads the new tables, then deployed via the
existing auto-deploy. Next migration number: **0020** (0019 = solver_reputation).
pgTAP lives in `supabase/tests/`. The `donation-qr` bucket is created **in** the
migration so local, CI, and remote agree.

Cross-chunk rule (DB discipline, carried from A/B/C): apply migration → verify with
pgTAP + `get_advisors` (the new RPCs are `SECURITY DEFINER`, `search_path=''`,
`EXECUTE` granted to `authenticated` only — same class as the existing `create_report`
/ `change_report_status` RPCs, so **no new advisor warning**; the new tables have RLS
enabled with explicit policies → **no missing-RLS** gap) → THEN merge the app code
that reads it. Per-chunk: `tsc`/`eslint`/`vitest`/`next build` green +
`/verification-before-completion` gate before each commit; push only on explicit user
authorization.

Key invariants the plan must preserve (from the spec + reviewer):
- **`solver_id` is ALWAYS `auth.uid()`** inside the RPCs, never client-supplied — a
  solver can only ever write their own channels (SCEN-002). A non-solver caller → `42501`.
- **Typed allowlist** (`nequi`/`daviplata`/`bancolombia`/`paypal`) + **`account_kind`
  coupling** (bancolombia ⇒ NOT NULL; every other type ⇒ NULL) enforced by DB `CHECK`
  (SCEN-003/004), with precise per-type format validation in Zod (SCEN-006).
- **`UNIQUE (solver_id, type)`** → re-setting a type **upserts** one row, never
  duplicates (SCEN-005).
- **Channels are public** (`SELECT USING (true)`); **history is admin-only**; neither
  table has any client write path (writes only through the DEFINER RPCs) (SCEN-010).
- **QR is hybrid**: Colombian rails are **uploaded** and sanitized to **lossless PNG**
  by a QR-safe `sharp` path that is **distinct from `processImage`** (the photo
  pipeline down-resizes to 2048 + lossy q82 → would break scannability); PayPal is a
  plain `paypal.me` URL → **auto-generated SVG** (SCEN-007/008).
- **PayPal validation** accepts only a `paypal.me` username (`^[A-Za-z0-9]{1,20}$`),
  rejects any other host and any extra path/query/fragment → normalized to
  `https://paypal.me/<user>` (anti-phishing/open-redirect) (SCEN-006).
- **Self-management lives under the existing `(account)` group** so the
  anonymous→`/ingresar` redirect is inherited from `(account)/layout.tsx`, not
  re-implemented (SCEN-011).
- **Audit**: every set/delete writes a `solver_donation_channel_history` row
  (`changed_by = auth.uid()` + request IP/UA folded into the snapshot from the route).
- The migration is **purely additive** — two new tables, two RPCs, one bucket; it
  touches no existing table, RPC, trigger, view, or policy.

---

## Chunk D1: Donation-channel data model, owner-gated RPCs, RLS, storage bucket

Foundation. No public behavior change until D2/D3 surface it. Satisfies the DB half of
SCEN-001..005, SCEN-010, SCEN-012.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `…/scenarios/donation-channels.scenarios.md` | NEW (done) | SDD holdout |
| `supabase/migrations/0020_donation_channels.sql` | NEW | `solver_donation_channels` (`id`, `solver_id → solver_profiles(id) on delete cascade`, `type` CHECK allowlist, `value`, `account_kind` CHECK + coupling CHECK, `qr_path`, timestamps, `UNIQUE(solver_id,type)`, coarse `value` length CHECK); `solver_donation_channel_history` (audit); RLS — channels `select` public, history admin-only, **no client write** on either (`revoke insert/update/delete`); `set_solver_donation_channel(p_type,p_value,p_account_kind,p_qr_path,p_request_meta jsonb default '{}')` + `delete_solver_donation_channel(p_type,p_request_meta jsonb default '{}')` — DEFINER, `search_path=''`, keyed to `auth.uid()`, allowlist+coupling validation, upsert, history write, `42501` if caller not a solver; `EXECUTE` granted to `authenticated`, revoked from `public`/`anon`; `donation-qr` **public** bucket via `insert into storage.buckets … on conflict do nothing` |
| `supabase/tests/solver_donation_channels_test.sql` | NEW | pgTAP for SCEN-001,002,003,004,005,010,012 |

### Steps
- [ ] **D1.1 — Migration `0020`** | Size: L | Deps: none — author the two tables, the
  two owner-gated DEFINER RPCs, the RLS policies, and the public `donation-qr` bucket,
  exactly as the spec's Data model + Authz sections. The RPCs derive `solver_id` from
  `auth.uid()` (never a parameter) and raise `42501` when the caller has no
  `solver_profiles` row. Apply to a **local** stack first (`supabase db reset`).
  **Fission point**: the channel table + RPCs + RLS are the irreducible core. The
  `history` audit table is the only *structurally* separable slice — but SCEN-001/012
  assert the history row, so **history ships in D1** (not deferred); the migration is one
  atomic transactional unit regardless.
  - **Accept**: `supabase db reset` applies `0020` clean on a local stack; the
    `donation-qr` bucket exists and is `public = true`; no existing table/RPC/trigger/
    view/policy is modified (diff shows only additions); the two RPCs exist with
    `EXECUTE` for `authenticated` only.
- [ ] **D1.2 — pgTAP `solver_donation_channels_test.sql`** | Size: L | Deps: D1.1 —
  isolated fixtures (solvers `S` and `T` + a non-solver authenticated user, built in the
  test with `set local role authenticated` + `request.jwt.claims`). Encode: SCEN-001
  (`S` calls `set_solver_donation_channel('nequi', …)` → one channel row for `S` + one
  `set` history row), SCEN-002 (`T`'s call writes only `T`'s row — `solver_id` forced to
  `auth.uid()`; a non-solver caller → `throws_ok '42501'`; `S`'s rows unchanged),
  SCEN-003 (a direct insert / RPC with `type='crypto'` → `throws_ok` check-constraint,
  **plus** a trailing `is(count, …)` confirming no row was created — matching the
  scenario's "no row exists" evidence verbatim), SCEN-004 (bancolombia without
  `account_kind` **and** a non-bancolombia type *with* `account_kind` — exercise both
  `nequi` and `daviplata`/`paypal` so the "every other type ⇒ NULL" branch is not
  nequi-only — all `throws_ok`; valid bancolombia-with-kind + valid nequi-without
  succeed), SCEN-005
  (second `set` for the same type → still exactly one row, new value, second history
  row), SCEN-010 (anon `SELECT` on `solver_donation_channels` returns `S`'s rows; anon
  `SELECT` on `solver_donation_channel_history` → **0 rows**), SCEN-012
  (`delete_solver_donation_channel('nequi')` → no `nequi` row for `S`, a `delete` history
  row exists). Assert by **reading the tables**, never by recomputing. Capture
  `get_advisors security` **before** the migration as the baseline. Run `supabase test
  db` until green on a fresh stack.
  - **Accept**: `solver_donation_channels_test.sql` passes on a fresh `supabase db reset`
    stack; `get_advisors security` diffed against the baseline shows **no new** warning
    (the RPCs match the existing authenticated-DEFINER class; both new tables have RLS
    enabled) — an observed before/after artifact, not an assertion.
- [ ] **D1.3 — Apply `0020` to remote** (user runs `supabase db push`; the MCP token
  cannot reach evidencialo's project) + re-run pgTAP via MCP `execute_sql`
  (`num_failed = 0`).
  - **Accept**: remote migration listed; remote pgTAP `num_failed = 0`; remote
    `get_advisors` baseline unchanged; the remote `donation-qr` bucket exists `public`.

## Chunk D2: Validation, service, QR-safe sanitizer, QR upload + channel routes, PayPal QR util

Wires the write path + the generation utilities. Satisfies SCEN-006, the sanitizer/route
half of SCEN-007, and the util half of SCEN-008.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `src/lib/validation/donationSchema.ts` | NEW | Zod per type: nequi/daviplata `^3\d{9}$`; bancolombia digits 10–16 + `account_kind ∈ {ahorros,corriente}`; paypal `paypal.me` username `^[A-Za-z0-9]{1,20}$` (or a `paypal.me` URL whose path is exactly that username — any extra path/query/fragment rejected) → normalized `https://paypal.me/<user>`; Spanish messages; coupling refinement |
| `src/lib/services/donationService.ts` | NEW | injectable `SupabaseClient`; `setChannel`/`deleteChannel` wrap the two RPCs; typed errors mapped from errcodes (`42501`→`ForbiddenError`, `23514`→`InvalidChannelError`, generic else); returns the echoed row |
| `src/lib/donation/qrImage.ts` | NEW | QR-safe sanitizer: `sharp` metadata-strip default + `MAX_PIXELS` guard, **lossless PNG** (`.png({compressionLevel:9})`), upper-cap ≤1024px (no upscale, no down-resize below scannable density), reject non-decodable input; output always PNG |
| `src/lib/donation/paypalQr.ts` | NEW | server-side SVG QR encoding the normalized `https://paypal.me/<user>`; thin wrapper over a QR lib (verified via Context7 at impl) |
| `src/app/api/solver/donation-qr/route.ts` | NEW | POST, Node runtime; owner-only (`getSessionRole()` + `isSolver`); `checkRateLimit` keyed `user:<id>`; run `qrImage` sanitizer; store `donation-qr/<uid>/<type>.png` (admin client); return path |
| `src/app/api/solver/donation-channels/route.ts` | NEW | POST/DELETE, Node runtime; **same** owner-gating as the QR route; validate via `donationSchema`; call `donationService`; pass request IP+UA as `p_request_meta` |
| `*.test.ts(x)` beside each | NEW | unit tests |

### Steps
- [ ] **D2.1 — `donationSchema` (Zod)** | Size: M | Deps: D1.3 — per-type validation +
  normalization. vitest covers SCEN-006: nequi/daviplata reject non-10-digit / non-`3`
  cells; bancolombia rejects non-numeric / out-of-length and requires a valid
  `account_kind`; paypal rejects non-`paypal.me` hosts and any path/query/fragment,
  accepts a bare username, normalizes to `https://paypal.me/<user>`; the coupling
  refinement rejects `account_kind` on non-bancolombia and absence on bancolombia.
  - **Accept**: `donationSchema.test.ts` green; every invalid value rejected with a
    Spanish message; every valid value accepted and PayPal normalized.
- [ ] **D2.2 — `qrImage` sanitizer + `paypalQr` util** | Size: M | Deps: D1.3 (parallel
  to D2.1) — the QR-safe sanitizer (lossless PNG, metadata stripped, ≤1024 cap, rejects
  non-image) satisfying the sanitizer half of SCEN-007; the PayPal QR util emitting
  deterministic SVG for a known normalized URL (SCEN-008). The QR lib for `paypalQr` is
  chosen + verified via Context7 before use (no API guessed from memory).
  - **Accept**: `qrImage.test.ts` — a real image in → PNG out, metadata gone, a ≤1024
    QR not downscaled, a non-image rejected; **and a real QR round-tripped through the
    sanitizer decodes back to its original payload** (scannability *observed* via a
    decode lib, not inferred from structural proxies — the load-bearing SCEN-007
    invariant); `paypalQr.test.ts` — deterministic SVG encoding `https://paypal.me/<user>`
    for a known user.
- [ ] **D2.3 — `donationService` + the two routes** | Size: M | Deps: D2.1, D2.2 — the
  service wraps the RPCs with error mapping; `donation-qr` route (owner-gated +
  rate-limited) runs `qrImage` and stores the PNG; `donation-channels` route (POST/DELETE,
  **identical** owner-gating via `getSessionRole()` + `isSolver`) validates + calls the
  service + threads IP/UA into `p_request_meta`. **The routes pass NO solver identity to
  the RPC** — `solver_id` is derived solely from `auth.uid()` inside the DEFINER; a
  client-supplied `solver_id` (if any) is never forwarded. vitest covers the route gates
  (owner-only → 401/403 for anon/non-solver; success), the cross-solver boundary
  (SCEN-002 at the HTTP layer), the validation being wired into the handler (SCEN-006),
  the sanitization being invoked (SCEN-007), and the service error mapping.
  - **Accept**: route + service tests green —
    (a) anonymous/non-solver rejected, owner succeeds;
    (b) **SCEN-002 route layer**: a request carrying a forged/other `solver_id` field is
    ignored — the write is scoped to the caller's `auth.uid()`, never another solver's
    (the route forwards no client solver id);
    (c) **SCEN-006 wired**: the channel route returns **422** for a non-`paypal.me` PayPal
    value (proves `donationSchema` is invoked on the write path, not just defined);
    (d) the sanitizer is invoked on upload, errcodes mapped; `tsc`/`eslint`/`vitest` green.

## Chunk D3: UI — public DonationBlock + (account) self-management

Surfaces the channels. Satisfies SCEN-009, SCEN-011, and the UI half of SCEN-007/008/012.

### File map
| File | New/Mod | Responsibility |
|---|---|---|
| `src/lib/services/solverService.ts` | MOD | read the solver's `solver_donation_channels` (public select) → expose `DonationChannel[]` on the profile data; type + mapping |
| `src/components/solver/DonationBlock.tsx` | NEW | presentational "Apóyalo" block: one card per channel (icon + label + copy affordance for nequi/daviplata/bancolombia via a small client sub-component, or "Abrir PayPal" link), plus the QR (`<img>` of the uploaded PNG, or the `paypalQr` SVG for PayPal); renders **nothing** when the solver has zero channels |
| `src/app/(public)/solucionadores/[handle]/page.tsx` | MOD | mount `DonationBlock` under the C `ReputationBlock`; show an "Editar mis canales" affordance only when `viewerId === profile.id` |
| `src/app/(account)/mi-perfil/donaciones/page.tsx` | NEW | authenticated, owner-scoped (loads the current user's solver profile by `auth.uid()`); a non-solver sees an empty/"no eres solucionador" state; the `(account)/layout.tsx` gate redirects anonymous → `/ingresar` (inherited) |
| `src/components/solver/DonationChannelsEditor.tsx` | NEW (client) | one editable row per type (value + `account_kind` for bancolombia + optional QR upload) → calls the `donation-qr` + `donation-channels` routes; save/delete per channel |
| `src/app/globals.css` | MOD | `.donation-block*`, `.donation-channel*`, editor styles |
| `*.test.tsx` beside components | NEW | component tests |

### Steps
- [ ] **D3.1 — `solverService` channels read + public `DonationBlock`** | Size: M | Deps:
  D2.3 — `solverService` exposes `DonationChannel[]`; `DonationBlock` renders the copy/link
  + QR per channel and renders nothing when empty (SCEN-009); for PayPal it renders the
  `paypalQr` SVG, for the rails the uploaded PNG (UI half of SCEN-007/008). Mounted under
  the reputation block on the public profile.
  - **Accept**: component tests green — block renders a copy affordance + QR per channel,
    a PayPal card shows the generated SVG, an empty profile renders no block; the public
    page mounts it below `ReputationBlock`.
- [ ] **D3.2 — `(account)/mi-perfil/donaciones` self-management** | Size: M | Deps: D2.3,
  D3.1 — the owner-scoped page (loaded by `auth.uid()`) + `DonationChannelsEditor` that
  saves/deletes per channel through the D2 routes and uploads QRs; the public profile's
  "Editar mis canales" affordance links here only for the owner (SCEN-011, UI half of
  SCEN-012). A non-solver authenticated user sees the empty state, never another solver's
  channels. `tsc`/`eslint`/`vitest`/`next build` green.
  - **Accept**: build green; the page resolves the editable profile from `auth.uid()`
    (no handle in the URL → no cross-solver edit path); component/route test covers the
    owner-scoping; the affordance shows only when `viewerId === profile.id`. (The
    anonymous→`/ingresar` redirect is inherited from `(account)/layout.tsx`; confirmed in
    D4.)

## Chunk D4: Runtime verification (agent-browser, local stack)

Closes the UI/runtime scenarios (SCEN-007/009/011/012) end-to-end, with DB spot-checks of
the SCEN-001..005 RPC effects via the real `set_solver_donation_channel` /
`delete_solver_donation_channel` calls. The pure-DB scenarios (001..005, 010) are fully
covered by D1.2 pgTAP and not re-run in the browser; SCEN-006/008 are vitest (D2) but the
PayPal QR is also observed present. No new code unless a scenario fails.

### Steps
- [ ] **D4.1 — Runtime SCEN-007/009/011/012 (+ DB spot-check 001..005)** | Size: M | Deps:
  D3.2 — local stack ([[local-stack-runtime-qa]] recipe — mind the
  **localhost-not-127.0.0.1** hydration block, the **native `.click()`** gotcha, and the
  **`@example.com` not `@local`** email-validator gotcha): seed a verified solver `S`,
  sign in, at `/mi-perfil/donaciones` add a **Nequi** channel + **upload its QR** and add
  a **PayPal** channel (DB spot-check: `solver_donation_channels` rows + `history` rows —
  SCEN-001/005; the QR stored as `.png` — SCEN-007); view `/solucionadores/<handle>` and
  observe the "Apóyalo" block — copy works, the uploaded Nequi QR shows, the PayPal QR is
  present (SCEN-007/008/009); **delete** the Nequi channel and confirm it disappears from
  the public block + a `delete` history row (SCEN-012); confirm a **second solver `T`
  cannot edit `S`'s channels** and an **anonymous** hit on `/mi-perfil/donaciones`
  redirects to `/ingresar` (SCEN-011/002). Console clean, zero failed requests.
  - **Accept**: each listed scenario observed in the browser with DB confirmation;
    console/network clean. Then `/verification-before-completion` gate.

## Testing strategy

- **pgTAP** (D1): SCEN-001 (set + history), 002 (owner-only / `solver_id = auth.uid()` /
  non-solver `42501`), 003 (allowlist CHECK), 004 (coupling CHECK both directions), 005
  (upsert unique), 010 (anon channels public / history 0 rows), 012 (delete + history).
  Advisors before/after diff: no new warning.
- **vitest** (D2/D3): `donationSchema` (per-type validation + PayPal normalization —
  SCEN-006), `qrImage` (lossless PNG, metadata strip, no down-resize, reject non-image,
  **+ decode round-trip** confirming scannability — SCEN-007), `paypalQr` (deterministic
  SVG — SCEN-008), `donationService` error mapping,
  the two routes (owner gating + sanitizer invoked), `DonationBlock` (copy/link + QR +
  empty state — SCEN-009), the self-management page owner-scoping (SCEN-011).
- **Runtime agent-browser** (D4): SCEN-007/009/011/012 on a local stack, with DB
  confirmation of the SCEN-001..005 RPC effects and the stored QR.

## Rollout

- `0020` applies cleanly from `0019`; additive only — two new tables, two RPCs, one
  public bucket; no change to any existing table, RPC, trigger, view, policy, or the
  public-map/visibility path. The `solver_profiles.links jsonb` column is untouched.
- DB-first per the cross-chunk rule: migrate + pgTAP + advisors green → then app code.
  `db.yml` triggers on `supabase/migrations/**` + `supabase/tests/**`, so the pgTAP runs
  in CI. `ci.yml` runs lint/type/test/build/deploy on push. Push per explicit user
  authorization. Remote `0020` is applied by the **user** (`supabase db push`) — the MCP
  token cannot reach evidencialo's project.
- The `donation-qr` bucket must exist in every environment; it is created in the
  migration so local, CI, and remote agree. Writes are server-side under the service role
  (the upload route), so no client storage policy is required; the bucket is public-read.
- No funds ever flow through evidencialo — there is no settlement/refund/reconciliation
  path to operate or roll back. Donations are entirely between donor and solver.
- Rollback: dropping `0020` removes the two tables + two RPCs + bucket; the app code is
  additive (no existing read/write path changes), so reverting the app commits restores
  prior behavior.
