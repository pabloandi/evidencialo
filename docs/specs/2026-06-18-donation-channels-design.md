---
title: Donation channels (subsystem D)
date: 2026-06-18
status: draft
epic: "Citizen reporting → validation → resolution → reputation → incentives (4 subsystems: A validation, B solvers, C reputation, D donations)"
note: Subsystem D of the larger vision — the final link ("incentives"). A (citizen validation), B (verified solvers + disputes) and C (solver reputation) are shipped. D lets a verified solver publish their OWN donation channels (Nequi, Daviplata, Bancolombia, PayPal) on their public profile so the public can support them directly. The platform NEVER custodies money — it only connects donor to solver. Reputation (C) renders beside the channels as the honest trust signal; D adds no gating.
---

# Donation channels (subsystem D)

## Problem

Subsystems A–C build a trust ladder: a citizen reports, the crowd corroborates
(A), a verified solver resolves (B), and the solver earns a graded, public
reputation from facts (C). The product vision treats **reputation as the link
between resolution (B) and incentives (D)**: once a solver's track record is
visible and earned, the public should be able to *support that solver directly*.
Today there is no surface for that — `/solucionadores/[handle]` shows who the
solver is and how reliable they are, but offers the public no way to act on that
trust. The forward-compat `solver_profiles.links jsonb` column (migration `0014`,
"socials/donation links — forward-compat for D") was reserved for exactly this and
is still unused.

The hard constraint is **money**. Actually moving funds — integrating a gateway,
custodying third-party money, settling to solvers, KYC, reconciliation, PCI, the
financial-regulation surface in Colombia — is a large, high-risk subsystem and was
explicitly a non-goal of the MVP ("Sin flujos de pago en el MVP", master
architecture spec). D must connect donor to solver **without evidencialo ever
touching the money.**

## Goals

- Let a verified solver **self-manage** a small set of their own donation channels
  (Nequi, Daviplata, Bancolombia, PayPal) and show them on their public profile,
  beside the C reputation block, so the public can support them **directly**.
- **The platform never custodies funds.** Donors pay the solver's own account
  through the solver's own rails; evidencialo only displays verified channel data.
- Make donating **easy on mobile** with QR codes the donor scans from their banking
  app — uploaded by the solver for the Colombian rails, auto-generated for PayPal.
- Keep the donation surface **honest**: the C reputation renders right next to the
  channels, so the donor judges with the track record in view. No reputation
  gating — display, not gatekeeping (consistent with C's "signal, not action").
- Treat a donation channel as a **money-redirect target** and secure it
  accordingly: owner-only writes through a `SECURITY DEFINER` RPC, a typed
  allowlist with per-type validation, sanitized QR uploads, and an audit trail.

## Non-goals (separate subsystems / future)

- **Payment processing / custody** — integrating a gateway (Wompi, MercadoPago,
  PSE), receiving funds, settling to solvers. Explicitly rejected for this
  subsystem (regulatory/PCI/custody burden; contradicts the MVP non-goal). D is
  verified-channel **display** only; the donor pays the solver directly.
- **Donation tracking / analytics** — counting "donate-intent" clicks, "X people
  viewed your channels". Rejected: evidencialo never sees the money, so any metric
  is a weak proxy; it adds a write path + table + privacy surface for low value.
  Pure display. (A natural later iteration with its own privacy design.)
- **Reputation gating of channels** — hiding channels below a reputation threshold,
  or requiring `resolved_count ≥ N`. Rejected: the C reputation already renders
  beside the channels; the donor judges. Display, not gatekeeping.
- **Generating Colombian-rail QRs from a phone/account** — researched and rejected
  as **technically impossible**: Nequi/Daviplata/Bancolombia payment QRs are
  app-minted EMVCo/Bre-B payloads, not the phone number encoded as text; a
  "generate-from-number" QR would scan to nothing (a trap). Bre-B's
  generate-from-llave QR is not an officially sanctioned external path yet. The
  reliable path is the solver uploading their app's exported QR. (PayPal.me is the
  one safe generate-yourself case — it is a plain URL.)
- **Channels for non-solver citizens** — D is solvers only (the trust ladder ends
  at the verified, reputation-bearing solver). Citizen tipping is out of scope.
- **Report-detail / map donation CTAs** — first cut is the profile only. A
  lightweight "Apoyar a @handle" link on the report-detail attribution badge is a
  natural later iteration; not in MVP (keeps the civic reporting flow free of
  "asking for money" noise).
- **More channel types** (Mercado Pago link, bank transfers beyond Bancolombia,
  crypto) — the typed allowlist starts at four and grows by adding an enum value +
  a validator; deliberately small to start.

## Design

### Decisions locked in brainstorming

- **What D does with money**: nothing — **verified donation channels, no custody**
  (Q1). The donor pays the solver's own account directly; evidencialo only shows
  the channel. Low risk, no financial regulation, reuses the reserved `links`
  intent.
- **Administration**: **solver self-service, with guards** (Q2). The solver (already
  admin-verified, not anonymous) edits their own channels via an authenticated
  write path, constrained by a typed allowlist, per-type validation, and an audit
  trail. Rejected: admin-curated (does not scale — every solver waits on an admin to
  publish/fix their Nequi); propose-then-approve hybrid (adds a moderation/pending
  state for marginal safety over the guards above).
- **Channel shape**: **typed channels with an allowlist + per-type validation**
  (Q3), starting with **Nequi, Daviplata, Bancolombia, PayPal**. Rejected: free-form
  URLs (phishing surface; cannot express the phone/account rails) and a URL+typed
  mix (duplicate validation logic).
- **Reputation gating**: **none** (Q4) — channels are always visible when set; the C
  reputation renders beside them so the donor judges. Consistent with C's
  display-not-gating principle.
- **Tracking**: **pure display, no tracking** (Q5). Evidencialo never sees the money;
  a click metric is a weak proxy not worth a write path + privacy surface.
- **Surfaces**: **profile only** (Q6) — the channels live on
  `/solucionadores/[handle]` under the C reputation block.
- **QR**: **hybrid** (Q7) — uploaded image for the Colombian rails (the only
  reliable path; see research below), auto-generated SVG for PayPal (a plain
  `paypal.me` URL).

### Why QR is hybrid (a researched, load-bearing constraint)

Colombian instant-payment QRs (Nequi, Daviplata, Bancolombia) are **app-minted
payloads**, not the phone/account number as text. Nequi's help docs confirm the QR
is generated in-app, is unique per user, and *regenerates if the phone number
changes* — so it cannot be reconstructed from the number. Daviplata's QR is an
**interoperable Bre-B** QR "asociado a sus llaves", produced by the Davivienda app.
Bre-B (Banco de la República's interoperable instant payments) does define an
EMVCo-based QR tied to a "llave", and natural-person QRs began rolling out in H1
2026 — but generation lives inside each bank's "Zona Bre-B" (requires location
permission; dynamic QRs carry a mandatory amount + 5-minute expiry), and there is
no sanctioned public API to mint one externally. **A QR that merely encodes a phone
number scans to nothing as a payment** — building one would be a trust-eroding trap.

Therefore: for Nequi/Daviplata/Bancolombia the solver **uploads** the QR their app
exported; for **PayPal**, a QR encoding `https://paypal.me/<user>` is a plain URL
that any phone camera opens on the payment page — that one we **generate**
server-side, no upload.

Sources: ayuda.nequi.com.co (Cómo generar el Código QR), davivienda.com/personas/
vender-con-llaves-y-qr, banrep.gov.co/es/bre-b/que-es, paypal.com (QR code
payments).

### Data model (migration `0020`)

A **dedicated child table**, not the `links jsonb` blob. Why: channels are 0–4 rows
per solver with an image, per-type validation, public read + owner-only write, and
an audit need — the project's table-with-RLS pattern (`report_disputes`,
`solver_profiles`) fits far better than an unconstrained blob. The reserved
`solver_profiles.links jsonb` stays free for future generic social links (no
conflict).

**(a) `solver_donation_channels`** (public read; no client write path):

| column | type | notes |
|---|---|---|
| `id` | `uuid PK default gen_random_uuid()` | |
| `solver_id` | `uuid NOT NULL → solver_profiles(id) ON DELETE CASCADE` | the owning solver |
| `type` | `text NOT NULL CHECK (type IN ('nequi','daviplata','bancolombia','paypal'))` | typed allowlist |
| `value` | `text NOT NULL` | cell (nequi/daviplata) / account number (bancolombia) / paypal user |
| `account_kind` | `text CHECK (account_kind IN ('ahorros','corriente'))` | **bancolombia only** |
| `qr_path` | `text` | storage path of the uploaded QR; `NULL` for paypal (auto-gen) or none |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |

Constraints:
- `UNIQUE (solver_id, type)` — **at most one channel per type** (so ≤ 4 per solver).
- `CHECK` coupling: `type = 'bancolombia'` ⇒ `account_kind IS NOT NULL`; every other
  type ⇒ `account_kind IS NULL`.
- A coarse `CHECK` on `value` (non-empty, length ≤ 256) as DB-layer defense in
  depth; precise per-type format validation lives in the application (Zod) +
  the write RPC.

**(b) `solver_donation_channel_history`** (audit; admin read only) — a donation
channel is a money-redirect target, so every change is recorded for forensics if a
channel is ever hijacked:

| column | type | notes |
|---|---|---|
| `id` | `uuid PK` | |
| `solver_id` | `uuid NOT NULL` | |
| `type` | `text NOT NULL` | |
| `action` | `text NOT NULL CHECK (action IN ('set','delete'))` | |
| `old_value` / `new_value` | `jsonb` | full channel snapshot before/after |
| `changed_by` | `uuid` | `auth.uid()` at change time |
| `changed_at` | `timestamptz NOT NULL DEFAULT now()` | |

**(c) Write RPCs** (`SECURITY DEFINER`, `search_path = ''`, fully-qualified;
`EXECUTE` granted to `authenticated` only, revoked from `public`/`anon`):

- `set_solver_donation_channel(p_type, p_value, p_account_kind, p_qr_path,
  p_request_meta jsonb DEFAULT '{}')` — **gated**: the caller must be the owning
  solver (`auth.uid()` exists in `solver_profiles`; the row written is keyed to
  `auth.uid()`, never a client-supplied `solver_id`). Validates the allowlist + the
  `account_kind` coupling, **upserts** on `(solver_id, type)`, and writes a `set`
  history row (folding `p_request_meta` — IP/user-agent passed by the route — into
  the snapshot). Raises `42501` (forbidden) if the caller is not a solver.
- `delete_solver_donation_channel(p_type, p_request_meta jsonb DEFAULT '{}')` — same
  gating; deletes the row and writes a `delete` history row.

The `solver_id` is **always `auth.uid()`**, never from the client → a solver can
only ever write their own channels (the SCEN-D-002 boundary).

**(d) Storage.** A new **public-read** bucket `donation-qr`, created in-migration
via `insert into storage.buckets (id, name, public) values ('donation-qr',
'donation-qr', true) on conflict (id) do nothing` (the same insert idiom migration
`0006` uses for `report-media` — though `report-media` is `public => false`;
`donation-qr` is deliberately `public => true`, justified below). A donation QR is intrinsically public (it exists to be
scanned) and lives on a cacheable public profile, so a public bucket gives stable,
CDN-cacheable URLs with no per-request signing cost — and signing would add
complexity for zero confidentiality benefit. Writes are restricted to the owning
solver (the upload route runs server-side under the service role after an owner
check; the bucket has no client write policy). Path convention:
`donation-qr/<solver_id>/<type>.png` — the QR sanitizer always emits **lossless
PNG** (see the write path), so the extension, the stored bytes, and the
content-type all agree; a re-upload overwrites in place and a channel delete removes
its object.

This migration **adds only** two tables, two RPCs, and a bucket; it does not modify
any existing table, RPC, trigger, or view.

### Write path / application layer

Mirrors the existing write paths (`disputeService` + the hybrid route pattern):

- **`src/lib/validation/donationSchema.ts`** — Zod, per type:
  - `nequi` / `daviplata` → Colombian mobile: **10 digits, `3`-prefixed**
    (`/^3\d{9}$/`), stored as digits only (strip spaces/dashes).
  - `bancolombia` → `account_kind ∈ {ahorros, corriente}` + account number
    (digits, length 10–16).
  - `paypal` → a `paypal.me` username (`/^[A-Za-z0-9]{1,20}$/`) or a `paypal.me` URL
    whose path is exactly that username; **normalized** to `https://paypal.me/<user>`.
    Reject any other host, and reject any extra path/query/fragment (closes
    open-redirect/phishing — no arbitrary URLs).
  - Spanish validation messages (mirrors existing 422 copy).
- **`src/lib/services/donationService.ts`** — injectable `SupabaseClient`, typed
  error classes mapped from Postgres errcodes (`42501` → `ForbiddenError`, `23514`
  CHECK → `InvalidChannelError`, generic else), wrapping the two RPCs. Returns the
  echoed channel row.
- **`src/lib/donation/qrImage.ts`** (NEW) — a **QR-safe** image sanitizer, distinct
  from the photo pipeline. The existing `processImage` (`src/lib/exif.ts`) is tuned
  for photos — it down-resizes to `FULL_MAX = 2048` and applies `FULL_QUALITY = 82`
  **lossy** webp/jpeg (mozjpeg) — which can introduce edge artifacts that break QR
  scannability (a silent donation failure). The QR sanitizer reuses sharp's
  metadata-stripping default (no `.withMetadata()` → EXIF gone) and the
  `MAX_PIXELS` decompression-bomb guard, but encodes **lossless PNG**
  (`.png({ compressionLevel: 9 })`), does **not** down-resize below a scannable
  density (only an upper cap, e.g. ≤ 1024px, never upscaling), and validates the
  input is a real decodable image. Output is always PNG → matches the `.png` storage
  path.
- **`src/app/api/solver/donation-qr/route.ts`** (POST, Node runtime) — authenticated,
  **owner-only** (session role resolved server-side via `getSessionRole()` +
  `isSolver`; a non-solver/anonymous caller → 403/401). Light rate-limit (reuse
  `checkRateLimit`, keyed by `user:<id>`) to bound storage abuse. Runs the QR
  sanitizer above, stores to `donation-qr/<uid>/<type>.png`, returns the path. No
  captcha (writes are authenticated, not anonymous).
- The channel **save/delete** path is a route **`POST` / `DELETE`
  `/api/solver/donation-channels`** (Node runtime), owner-gated **the same way** as
  the QR-upload route (`getSessionRole()` + `isSolver` — the two must not drift),
  calling `set_solver_donation_channel` / `delete_solver_donation_channel` via
  `donationService`. The save route also passes the request **IP + user-agent** to
  the RPC so the audit snapshot records them (see audit, below). The management UI:
  the choose-QR upload returns a `qr_path`, then the save call persists the channel
  with it.

### Read path / surfaces

- **Public solver profile `/solucionadores/[handle]`** — the only surface.
  `solverService` gains a read of the solver's `solver_donation_channels` (public
  select) exposed as a typed `DonationChannel[]` on the profile data. A new
  presentational **`DonationBlock`** renders under the C `ReputationBlock`:
  - Heading "Apóyalo".
  - One card per channel: icon + label, and either a **"Copiar" button**
    (nequi/daviplata cell; bancolombia `account_kind` + number) — a small client
    sub-component for the clipboard — or an **"Abrir PayPal" link**
    (`https://paypal.me/<user>`).
  - QR: an `<img>` of the uploaded QR (public bucket URL) for the Colombian rails, or
    a **server-generated SVG** QR encoding the `paypal.me` URL for PayPal.
  - **Empty state: if the solver has zero channels, the block does not render**
    (no "no recibe donaciones" noise).
- **Solver self-management `/mi-perfil/donaciones`** — a new **authenticated,
  owner-scoped** page placed under the existing **`(account)`** route group
  (`src/app/(account)/mi-perfil/donaciones/page.tsx`). The group's
  `(account)/layout.tsx` already redirects any anonymous visitor to `/ingresar`
  **before the route renders**, so SCEN-D-011's anonymous-redirect guarantee is
  inherited free (do not create a parallel auth group). The page loads the current
  user's own solver profile by `auth.uid()` (no handle in the URL): one editable row
  per type — value (+ `account_kind` for bancolombia), optional QR upload,
  save/delete per channel. A non-solver authenticated user has no solver profile →
  sees an empty/"no eres solucionador" state, never another solver's channels. The
  solver's own public profile shows an "Editar mis canales" affordance only when
  `viewerId === profile.id`.

### PayPal QR generation

Generated **server-side** as inline SVG (no client JS) encoding
`https://paypal.me/<user>`. The QR library is chosen and verified via Context7 at
implementation time (candidate: `qrcode`); it is a thin, well-tested utility
(`src/lib/donation/paypalQr.ts`) with its own unit test (deterministic output for a
known URL). Only `paypal.me` URLs are ever encoded (validated upstream).

### Authz / RLS / abuse

- **Owner-only writes.** Both RPCs key the row to `auth.uid()` and verify the caller
  is a solver; a non-owner (or non-solver) call raises `42501`. `solver_id` is never
  client-supplied → no cross-solver writes.
- **No client write path on the tables.** `solver_donation_channels` has only a
  public `SELECT` policy (`USING (true)` — channels are public by design); INSERT/
  UPDATE/DELETE are revoked from `public`/`anon`/`authenticated` and happen only
  through the DEFINER RPCs. `solver_donation_channel_history` is **admin read only**
  (forensics), no client write path.
- **Typed allowlist + per-type validation** bound the abuse surface: only four known
  types, phone/account/paypal validated, PayPal restricted to `paypal.me` (no
  arbitrary phishing URLs).
- **QR uploads are sanitized** (re-encoded, metadata stripped, validated as images)
  and owner-scoped; the upload route is rate-limited.
- **Audit trail.** Every set/delete writes a history row (`changed_by = auth.uid()`,
  plus the request IP + user-agent in the snapshot `jsonb` — passed from the route,
  since the worst case is a *compromised* solver account where `auth.uid()` is the
  victim, so "the account did it" alone is weak forensics). A hijacked-channel claim
  is then investigable beyond just the account id. We do **not** validate what a QR
  encodes (we cannot decode intent reliably) — the mitigations are the verified-
  solver precondition (B), the audit trail, and admin visibility, the same risk
  posture as a solver typing a wrong account number.
- **Residual risk (stated, not hidden):** a verified solver could publish a channel
  that routes to an attacker (self-directed fraud or a compromised solver account).
  This is inherent to any "publish your own payment info" feature; it is bounded by
  admin verification of solvers, the audit trail, and the public reputation beside
  the channel — not eliminated. No custody means evidencialo bears no funds risk.

## Validation rules (precise, so Zod and pgTAP agree)

| type | `value` rule | `account_kind` |
|---|---|---|
| `nequi` | `/^3\d{9}$/` (10 digits, 3-prefixed), digits only | must be `NULL` |
| `daviplata` | `/^3\d{9}$/` | must be `NULL` |
| `bancolombia` | digits, length 10–16 | required, `∈ {ahorros, corriente}` |
| `paypal` | a `paypal.me` **username** (`/^[A-Za-z0-9]{1,20}$/`) or a `paypal.me` URL from which that username is extracted — **any path, query, or fragment is rejected** (no `paypal.me/../x`, no `?redirect=…`) → normalized to `https://paypal.me/<user>` | must be `NULL` |

- Unknown `type` → rejected (allowlist CHECK + Zod enum).
- `account_kind` present on a non-bancolombia type, or absent on bancolombia →
  rejected (coupling CHECK + Zod refinement).
- Re-setting an existing type **upserts** (updates the one row), never duplicates
  (`UNIQUE (solver_id, type)`).

## Observable scenarios (SDD holdout)

- **SCEN-D-001 (owner sets a channel + audit)** — Given a verified solver `S` signed
  in, when `S` sets a Nequi channel with a valid cell, then a
  `solver_donation_channels` row exists with `solver_id = S`, `type = 'nequi'`, that
  value, and a `solver_donation_channel_history` `set` row is recorded.
- **SCEN-D-002 (non-owner cannot write)** — Given `S`'s channels, when a *different*
  authenticated user calls the set/delete RPC (attempting to target `S`), then it is
  refused (`42501`) and no row of `S`'s changes (`solver_id` is forced to
  `auth.uid()`).
- **SCEN-D-003 (allowlist enforced)** — Given an attempt to set a channel of a type
  not in the allowlist (e.g. `crypto`), then it is rejected and no row is created.
- **SCEN-D-004 (account_kind coupling)** — Given a `bancolombia` channel with no
  `account_kind`, it is rejected; given a `nequi` channel *with* an `account_kind`,
  it is rejected (the coupling CHECK / Zod refinement).
- **SCEN-D-005 (one per type, upsert not duplicate)** — Given `S` already has a Nequi
  channel, when `S` sets Nequi again with a new value, then the existing row is
  **updated** (not duplicated), `UNIQUE (solver_id, type)` holds, and history records
  the change.
- **SCEN-D-006 (per-type value validation)** — Given invalid values (a Nequi cell
  that is not 10 digits / not `3`-prefixed; a Bancolombia value that is non-numeric;
  a PayPal value on a non-`paypal.me` host), validation rejects each with a Spanish
  message; valid values are accepted and normalized (PayPal → `https://paypal.me/…`).
- **SCEN-D-007 (QR upload sanitized + stored)** — Given `S` uploads a QR image for
  Nequi, when the upload route processes it, then the image is sanitized
  (metadata stripped / re-encoded, still scannable) and stored, and the channel's
  `qr_path` points at it.
- **SCEN-D-008 (PayPal QR auto-generated)** — Given `S` has a PayPal channel
  `paypal.me/<user>`, when the public profile renders, then a QR encoding
  `https://paypal.me/<user>` is generated server-side and shown — with no uploaded
  image.
- **SCEN-D-009 (public display block + empty state)** — Given `S` has ≥ 1 channel,
  when anyone reads `/solucionadores/[handle]`, then the "Apóyalo" block shows each
  channel with a copy affordance (nequi/daviplata/bancolombia) or an open-PayPal link
  plus its QR; given `S` has zero channels, the block does not render.
- **SCEN-D-010 (channels public, audit is not)** — Given `S`'s channels and their
  history, an anonymous client can read `solver_donation_channels` (public), but
  cannot read any `solver_donation_channel_history` row (admin only).
- **SCEN-D-011 (owner-only management surface)** — Given the management page
  `/mi-perfil/donaciones`, when an anonymous user requests it, they are redirected to
  sign in; when a non-owner authenticated user requests it, they cannot edit another
  solver's channels; the owning solver sees and edits only their own.
- **SCEN-D-012 (delete removes channel + audit)** — Given `S` has a Nequi channel,
  when `S` deletes it, then the row is gone, a `delete` history row is recorded, and
  the public block no longer shows it.

## Testing strategy

- **pgTAP** (`solver_donation_channels_test.sql`), isolated fixtures (solver(s) +
  channels built in the test): the set RPC writes the row + history (SCEN-D-001);
  non-owner / non-solver call raises `42501` and changes nothing (SCEN-D-002);
  allowlist CHECK rejects an unknown type (SCEN-D-003); the `account_kind` coupling
  CHECK both directions (SCEN-D-004); upsert keeps one row per `(solver_id, type)`
  (SCEN-D-005); RLS — anon `SELECT` returns channels but zero history rows
  (SCEN-D-010); delete removes the row + writes history (SCEN-D-012). Assert by
  **reading the table**, not by recomputing. Set `plan(...)` accordingly.
- **vitest**: the Zod schemas per type incl. boundaries and normalization
  (SCEN-D-006); the PayPal QR utility (deterministic output for a known URL,
  SCEN-D-008); `donationService` error mapping; the QR upload route (owner gating +
  sanitization invoked + success, SCEN-D-007); `DonationBlock` render (copy
  affordance, PayPal QR generated, uploaded QR shown, empty state, SCEN-D-009); the
  management page owner gating (SCEN-D-011).
- **Runtime (agent-browser, local stack)** — a solver signs in, adds Nequi + uploads
  a QR + adds PayPal at `/mi-perfil/donaciones`, sees the channels on their public
  profile, copy works, the PayPal QR is present, and a non-owner cannot edit; console
  clean, no failed requests. (Local-stack recipe; `localhost` not `127.0.0.1`.)

The observable scenarios above are the SDD holdout — satisfaction is measured
against them, not against the tests; a scenario is never weakened to match code.

## Implementation chunks

- **D1** — migration `0020` (`solver_donation_channels` + `solver_donation_channel_
  history` + the two DEFINER RPCs + RLS + the `donation-qr` bucket) +
  `solver_donation_channels_test.sql` pgTAP.
- **D2** — application layer: `donationSchema` (Zod per type), `donationService`
  (RPC wrappers + error mapping), the QR upload route + sanitization, the PayPal QR
  utility + vitest.
- **D3** — UI: public `DonationBlock` on the profile + the owner-scoped
  `/mi-perfil/donaciones` management page + the "Editar mis canales" affordance +
  vitest + `globals.css`.
- **D4** — runtime verification (agent-browser, local stack) closing the scenarios.

(Final chunking is sop-planning's call; this is the expected shape.)

## Files / migrations / blast radius

- **NEW**: `supabase/migrations/0020_donation_channels.sql`,
  `supabase/tests/solver_donation_channels_test.sql`,
  `src/lib/validation/donationSchema.ts`, `src/lib/services/donationService.ts`,
  `src/lib/donation/paypalQr.ts` (PayPal QR SVG generation),
  `src/lib/donation/qrImage.ts` (QR-safe upload sanitizer — lossless PNG, sharp),
  `src/app/api/solver/donation-qr/route.ts`,
  `src/app/api/solver/donation-channels/route.ts` (POST/DELETE channel save/delete),
  `src/components/solver/DonationBlock.tsx`,
  `src/app/(account)/mi-perfil/donaciones/page.tsx` (+ its client editor component)
  — each with a test beside it.
- **MODIFIED**: `src/lib/services/solverService.ts` (read + expose
  `DonationChannel[]` on the profile),
  `src/app/(public)/solucionadores/[handle]/page.tsx` (mount `DonationBlock` +
  owner "Editar mis canales" affordance), `src/app/globals.css`
  (`.donation-block*`, `.donation-channel*`). The QR sanitizer reuses **sharp
  primitives** (the `src/lib/exif.ts` approach: metadata-stripping default +
  `MAX_PIXELS` guard) but is a **new QR-safe unit** (lossless PNG, no lossy
  down-resize) — it does **not** reuse `processImage`/`mediaService` (those are
  photo-tuned and coupled to `report_media`).
- **Blast radius**: the migration is **purely additive** — two new tables, two new
  RPCs, one bucket; it touches no existing table, RPC, trigger, view, or RLS policy.
  C's reputation block and the existing profile wall are unaffected; `DonationBlock`
  renders below them. No public-map / `reports_in_view` / visibility change. The
  `links jsonb` column is left untouched (free for future social links).

## Rollout plan

- Migration `0020` applies cleanly from `0019` (subsystem C). Additive only; existing
  solvers simply have zero channels until they add some (the block does not render).
- Per-chunk: pgTAP + vitest + `next build` green, `/verification-before-completion`
  before each commit, push per explicit user authorization (the established cadence).
  CI `db.yml` triggers on `supabase/tests/**` (pgTAP runs); `ci.yml` gates lint/
  typecheck/test/build.
- The `donation-qr` bucket must exist in every environment — created by the migration
  (or `config.toml`/storage migration) so local, CI, and remote agree; the remote
  bucket is provisioned when the user applies `0020` (`supabase db push`, since the
  MCP token cannot reach evidencialo's project).
- No funds ever flow through evidencialo — there is no settlement, refund, or
  reconciliation path to operate. Donations are entirely between donor and solver.
