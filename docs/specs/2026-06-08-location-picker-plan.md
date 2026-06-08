---
title: Implementation plan — location picker (issue #1)
date: 2026-06-08
spec: docs/specs/2026-06-08-location-picker-design.md
scenarios: docs/specs/2026-05-31-stack-arquitectura/scenarios/location-picker.scenarios.md
---

# Implementation plan — location picker

Holdout scenarios: SCEN-001..006 in `location-picker.scenarios.md` (committed before
code). Each step below embeds its scenario(s); no standalone "add tests" steps.

## Chunk 1: Location picker feature

### File structure map

| File | New/Mod | Responsibility |
|---|---|---|
| `src/lib/map/config.ts` | NEW | Single source of map config: `INITIAL_CENTER`, `INITIAL_ZOOM`, `mapStyleUrl()` + `hasMapKey()` guard. No React, no MapLibre import. |
| `src/components/map/MapView.tsx` | MOD | Import center/zoom/style from `config.ts` instead of local constants. No behavior change. |
| `src/components/capture/LocationPicker.tsx` | NEW | Controlled full-screen sheet: MapLibre map + fixed center-pin overlay; props `initialCenter`, `onConfirm({lat,lng})`, `onCancel`; "Usar mi ubicación" / "Confirmar" / "Cancelar". Owns map lifecycle + GPS + init-error state. |
| `src/components/capture/LocationPicker.test.tsx` | NEW | Unit: confirm returns `getCenter()`; cancel no-op; flyTo on GPS; GPS-denied note; init-error state. |
| `src/components/capture/CaptureForm.tsx` | MOD | Replace direct-GPS button with "Elegir ubicación en el mapa"; open/close picker; set `coords` only on confirm; "Ubicación fijada: …toFixed(5)" + "Cambiar"; keep submit validation. |
| `src/components/capture/CaptureForm.test.tsx` | MOD | Location flow: no-coords blocks submit; confirm → payload carries picked point; cancel → coords unchanged; "Cambiar" reopens. |
| `src/app/globals.css` | MOD | Picker styles: full-screen sheet, centered pin overlay, controls, `touch-action` for map gestures, focus styles. |
| `…/scenarios/location-picker.scenarios.md` | NEW (done) | SDD holdout SCEN-001..006. |

Boundary: `LocationPicker` knows nothing about reports/categories/captcha — it takes an
initial center and returns a point. `CaptureForm` owns when it opens and what to do with
the result. `config.ts` is pure data/helpers, independently testable.

### Prerequisites
- None new. `maplibre-gl` already a dependency (used by `MapView`). No API/DB/migration
  changes (`create_report` already accepts `lng`/`lat`).

### Steps

**Step 1 — Foundation: shared map config + scenarios holdout.** Size: S. Deps: none.
- Create `src/lib/map/config.ts` (`INITIAL_CENTER` `[-74.08, 4.61]`, `INITIAL_ZOOM` `12`,
  `mapStyleUrl()` building the MapTiler `dataviz` URL from `NEXT_PUBLIC_MAPTILER_KEY`,
  `hasMapKey()`). Refactor `MapView.tsx` to import them; delete its local constants.
- Commit the holdout `location-picker.scenarios.md` (`--no-verify`, before code).
- Acceptance: `tsc`/`lint`/`build` green; `MapView` renders the same Bogotá map (no
  behavior change — existing MapView build/tests pass); `config.ts` exports the exact
  prior values.

**Step 2 — LocationPicker core (SCEN-001, SCEN-002).** Size: M. Deps: Step 1.
- Build `LocationPicker.tsx`: full-screen sheet, `new maplibregl.Map` centered on
  `initialCenter`, a fixed CSS center-pin overlay, NavigationControl. "Confirmar" reads
  `map.getCenter()` → `onConfirm({lat,lng})`; "Cancelar" → `onCancel`; "Usar mi
  ubicación" → `getPosition()` then `map.flyTo`. GPS never blocks open (non-blocking).
- `LocationPicker.test.tsx` (mock `maplibregl` map: `getCenter`/`flyTo`/`on`/`remove`/
  `addControl`/`getCanvas` — a missing method throws at test time;
  mock `getPosition`): confirm returns the center (SCEN-001); after a `flyTo`+simulated
  pan, confirm returns the new center not the GPS point (SCEN-002); cancel does not call
  `onConfirm`.
- Acceptance: SCEN-001/002 satisfied at unit level; `tsc`/`lint` green.

**Step 3 — Picker error handling (SCEN-005 + map init failure).** Size: S. Deps: Step 2.
- GPS denied → non-blocking note, no throw (SCEN-005). Map init failure → `hasMapKey()`
  guard + a `map.on('error', …)` listener → readable message, user can cancel; never a
  silent success. NOTE: divergence from `MapView`, which returns a *fallback card* on
  missing key — the picker instead shows an *error + Cancelar* (a reviewer should not
  expect identical behavior).
- Tests: rejected `getPosition()` shows the note and confirm still works; missing key →
  error state rendered (no map).
- Acceptance: SCEN-005 satisfied; init-failure path covered; `tsc`/`lint` green.

**Step 4 — CaptureForm integration (SCEN-003, SCEN-004, SCEN-001 at form level).**
Size: M. Deps: Step 2.
- Replace the "Usar mi ubicación" GPS button with "Elegir ubicación en el mapa" that
  opens `LocationPicker`. `coords` set only on confirm; cancel is a no-op. After confirm
  show `Ubicación fijada: {lat.toFixed(5)}, {lng.toFixed(5)}` + "Cambiar" (reopens).
- **Update the stale submit-block message** at `CaptureForm.tsx:235` — it currently
  names the removed button (`"…con el botón "Usar mi ubicación"."`); change it to
  reference "Elegir ubicación en el mapa" (SCEN-004's location-required message).
- **Rewrite, do not preserve, the existing location assertions.** The current happy-path
  test (`CaptureForm.test.tsx:189-191`) clicks `"Usar mi ubicación"` and asserts
  `/Ubicación capturada/` — both removed by this step. Replace with: open the picker via
  "Elegir ubicación en el mapa", simulate `onConfirm`, assert `/Ubicación fijada/`. The
  mocked submit chain (idempotency/upload/media) is otherwise unchanged.
- `CaptureForm.test.tsx`: no coords → submit blocked, no `fetch` (SCEN-004); simulate
  confirm → `POST /api/reports` body carries the picked point (SCEN-001); cancel → coords
  unchanged (SCEN-003); "Cambiar" reopens. `CaptureForm.turnstile.test.tsx` does not
  touch the location button → verify it stays green untouched.
- Acceptance: SCEN-001/003/004 satisfied; full suite green (the location happy-path
  assertions rewritten, turnstile test unaffected).

**Step 5 — Styles + a11y polish.** Size: S. Deps: Step 4.
- `globals.css`: full-screen sheet, centered pin overlay (crosshair), control bar,
  `touch-action: none` on the map canvas so panning doesn't scroll the page, focus
  styles. Escape key cancels; focus moves into the sheet on open and back on close.
  NOTE: the focus-trap + Escape-to-cancel is NEW a11y surface (no existing modal/sheet
  precedent in the codebase) — budget accordingly, this is the heaviest part of "S".
- Acceptance: `lint`/`build` green; keyboard: Escape cancels, focus trapped in sheet.

**Step 6 — Integration verification (SCEN-006).** Size: S. Deps: Steps 3–5.
- Run dev server + agent-browser: open `/reportar`, open the picker, pan to a point that
  is NOT the (stubbed) GPS, confirm, fill the rest, submit a complete report. Verify the
  created report's coords match the picked point (DB/MCP) and the console is clean / no
  failed requests (SCEN-006).
- Acceptance: SCEN-006 satisfied with fresh evidence; then `/verification-before-completion`
  gate (full suite + tsc + lint + build) before any commit/PR.

### Testing strategy
- Unit (vitest + jsdom): `LocationPicker.test.tsx`, `CaptureForm.test.tsx` — precise
  assertions, mock MapLibre + `getPosition`, no loose matchers.
- Runtime (agent-browser): SCEN-006 on a real browser; stub `navigator.geolocation` so
  the "GPS vs picked" distinction is observable.
- Regression: full `pnpm test` after each functional step; MapView unchanged by Step 1.

### Rollout plan
- Client-only; ships through the existing GitHub Actions auto-deploy (push to `main` →
  gate → remote Vercel build). No env vars, no migration.
- Verify on the prod alias after deploy (agent-browser): picker works, a real submit
  lands at the picked coords, console clean.
- Rollback: revert the feature commit(s); `vercel promote <previous-good-deployment>` if
  prod needs immediate restore (precedent from the deployment runbook).
