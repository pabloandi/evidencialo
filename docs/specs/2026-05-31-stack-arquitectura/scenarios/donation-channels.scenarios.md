---
name: donation-channels
created_by: brainstorming
created_at: 2026-06-18T00:00:00Z
spec: docs/specs/2026-06-18-donation-channels-design.md
note: Subsystem D — verified donation channels on a solver's public profile. A verified solver self-manages a small typed set of their own channels (nequi, daviplata, bancolombia, paypal) via owner-only DEFINER RPCs (solver_id is ALWAYS auth.uid(), never client-supplied); the platform never custodies money — the donor pays the solver directly. Channels are public; an admin-only history table audits every change (with request IP/UA). Per-type validation (nequi/daviplata = 10-digit 3-prefixed cell; bancolombia = account number + ahorros|corriente; paypal = paypal.me username only, normalized, no arbitrary path/query → anti-phishing). QR is HYBRID: Colombian rails (nequi/daviplata/bancolombia) are app-minted EMVCo/Bre-B payloads that CANNOT be generated from a number, so the solver UPLOADS the image (sanitized to lossless PNG via a QR-safe sharp path, distinct from the photo processImage); PayPal is a plain paypal.me URL, so its QR is auto-generated server-side as SVG. Display is profile-only, beside the C reputation block; no tracking; no reputation gating. Self-management lives under the existing (account) auth group so the anonymous→/ingresar redirect is inherited. Chunks D1 (migration 0020: tables + RPCs + RLS + donation-qr public bucket + pgTAP), D2 (Zod schema + donationService + QR upload route + QR-safe sanitizer + PayPal QR util), D3 (UI: public DonationBlock + (account)/mi-perfil/donaciones self-management), D4 (runtime). SCEN-001..012 map 1:1 to the spec's SCEN-D-001..012.
---

# Scenarios — donation channels (subsystem D)

A verified solver publishes their own donation channels (Nequi, Daviplata,
Bancolombia, PayPal) on their public profile so the public can support them
directly — evidencialo never touches the money. Channels are owner-managed through
guarded server RPCs (a solver can only ever write their own), typed and validated
per rail, and audited. Donating is made easy with QR codes: uploaded by the solver
for the Colombian rails (whose payment QRs are app-minted and cannot be synthesized
from a number), auto-generated for PayPal (a plain URL). The C reputation renders
beside the channels so the donor judges with the track record in view; there is no
reputation gating and no tracking.

---

## SCEN-001 (D1 — owner sets a channel + audit row)
**Given**: a verified solver `S` signed in
**When**: `S` sets a Nequi channel with a valid 10-digit `3`-prefixed cell
**Then**: a `solver_donation_channels` row exists with `solver_id = S`, `type = 'nequi'`, that value, and a `solver_donation_channel_history` row with `action = 'set'` is recorded
**Evidence**: pgTAP — after calling `set_solver_donation_channel` as `S`, the channel row and a `set` history row both exist with `solver_id = S`.

## SCEN-002 (D1 — a solver can only write their own channels)
**Given**: solver `S`'s channels and a *different* authenticated solver `T`
**When**: `T` calls the set/delete RPC (attempting to affect `S`)
**Then**: the write only ever targets `T`'s own row (`solver_id` is forced to `auth.uid()`), and `S`'s channels are unchanged; a non-solver caller is refused (`42501`)
**Evidence**: pgTAP — the RPC keys on `auth.uid()`; after `T`'s call no `S` row changed; a non-solver authenticated caller raises `42501`.

## SCEN-003 (D1 — type allowlist enforced)
**Given**: an attempt to set a channel whose `type` is not in the allowlist (e.g. `crypto`)
**When**: the set RPC / table insert runs
**Then**: it is rejected (allowlist `CHECK` + Zod enum) and no row is created
**Evidence**: pgTAP — a direct insert (or RPC call) with `type = 'crypto'` raises a check-constraint error; no row exists.

## SCEN-004 (D1 — account_kind coupling)
**Given**: a `bancolombia` channel with no `account_kind`, and separately a `nequi` channel *with* an `account_kind`
**When**: each is set
**Then**: both are rejected (the coupling `CHECK`: bancolombia ⇒ `account_kind NOT NULL`; every other type ⇒ `account_kind NULL`)
**Evidence**: pgTAP — `throws_ok` on both shapes; a valid bancolombia (with `account_kind`) and a valid nequi (without) succeed.

## SCEN-005 (D1 — one channel per type, upsert not duplicate)
**Given**: `S` already has a Nequi channel
**When**: `S` sets Nequi again with a new value
**Then**: the existing row is **updated** (not duplicated), `UNIQUE (solver_id, type)` holds, and history records the change
**Evidence**: pgTAP — after a second `set` for the same type, exactly one `nequi` row exists for `S` with the new value, and a second `set` history row is present.

## SCEN-006 (D2 — per-type value validation + normalization)
**Given**: candidate channel values
**When**: validated for display/persistence
**Then**: a Nequi/Daviplata cell that is not 10 digits or not `3`-prefixed is rejected; a Bancolombia value that is non-numeric (or out of length 10–16) is rejected; a PayPal value on a non-`paypal.me` host or with any extra path/query/fragment is rejected; valid values are accepted and PayPal is normalized to `https://paypal.me/<user>` (`<user>` matching `^[A-Za-z0-9]{1,20}$`)
**Evidence**: vitest — the Zod schema rejects each invalid value with a Spanish message and accepts/normalizes each valid one.

## SCEN-007 (D2 — QR upload is sanitized + stored, still scannable)
**Given**: `S` uploads a QR image for Nequi
**When**: the upload route processes it
**Then**: the image is sanitized (metadata stripped, re-encoded **lossless PNG** with no aggressive down-resize so it stays scannable), stored at `donation-qr/<S>/nequi.png`, and the channel's `qr_path` points at it
**Evidence**: vitest — the QR-safe sanitizer (`qrImage.ts`) strips metadata, outputs PNG, does not downscale a ≤1024px QR, and rejects a non-image; the route stores it and returns the path. (Confirmed end-to-end in D4 runtime.)

## SCEN-008 (D2 — PayPal QR auto-generated, no upload)
**Given**: `S` has a PayPal channel `paypal.me/<user>`
**When**: the public profile renders
**Then**: a QR encoding `https://paypal.me/<user>` is generated server-side (SVG) and shown — with no uploaded image
**Evidence**: vitest — the PayPal QR utility returns deterministic SVG encoding the normalized URL for a known user; the block renders it without a `qr_path`.

## SCEN-009 (D3 — public display block + empty state)
**Given**: `S` has ≥ 1 channel
**When**: anyone reads `/solucionadores/[handle]`
**Then**: an "Apóyalo" block shows each channel with a copy affordance (nequi/daviplata cell; bancolombia kind + number) or an "Abrir PayPal" link, plus its QR; given `S` has **zero** channels the block does not render
**Evidence**: vitest — `solverService` exposes `DonationChannel[]`; `DonationBlock` renders copy/link + QR per channel and renders nothing when empty. agent-browser — the block appears below the reputation block with the channels, and is absent for a solver with no channels.

## SCEN-010 (D1 — channels are public, the audit log is not)
**Given**: `S`'s channels and their history rows
**When**: an anonymous client reads `solver_donation_channels` and attempts to read `solver_donation_channel_history`
**Then**: the channels are readable (public donation info), but no history row is (audit is admin-only)
**Evidence**: pgTAP — anon `SELECT` on `solver_donation_channels` returns `S`'s rows; anon `SELECT` on `solver_donation_channel_history` returns 0 rows.

## SCEN-011 (D3 — owner-only self-management surface)
**Given**: the management page `/mi-perfil/donaciones` under the `(account)` auth group
**When**: an anonymous user requests it / a non-solver authenticated user requests it / the owning solver requests it
**Then**: the anonymous user is redirected to `/ingresar` (inherited from `(account)/layout.tsx`); the non-solver sees no editable channels (they have no solver profile); the owning solver sees and edits only their own channels (the page loads by `auth.uid()`, never another solver's)
**Evidence**: vitest/route — the page resolves the editable profile from `auth.uid()`; agent-browser — anonymous → `/ingresar`, owner edits their own, no cross-solver edit path exists.

## SCEN-012 (D1 — delete removes the channel + audit row)
**Given**: `S` has a Nequi channel
**When**: `S` deletes it
**Then**: the row is gone, a `solver_donation_channel_history` row with `action = 'delete'` is recorded, and the public block no longer shows it
**Evidence**: pgTAP — after `delete_solver_donation_channel`, no `nequi` row for `S` remains and a `delete` history row exists. agent-browser — the channel disappears from the public profile.
