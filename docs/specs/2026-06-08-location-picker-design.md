---
title: Location picker — choose the report location on a map, not just device GPS
date: 2026-06-08
status: approved
issue: https://github.com/pabloandi/evidencialo/issues/1
related:
  - docs/specs/2026-05-31-stack-arquitectura/scenarios/citizen-capture.scenarios.md
---

# Location picker (issue #1)

## Problem

A report's location is currently sourced **only** from device GPS: `CaptureForm`'s
"Usar mi ubicación" button calls `getPosition()` (`src/lib/native/capture.ts`) and
stores the result in `coords`. That geolocates **the citizen, not the problem**. A
citizen who sees a pothole and submits the report later — from home — pins the marker
at home, not at the pothole. Result: wrong coordinates on the public map and reports
that cannot be acted on by location.

## Goals

- Let the citizen **fix/adjust the report location on a map**, independent of where
  they physically are when they submit.
- Keep "use my location" as a **convenience shortcut** (a starting point), not the
  only source.
- Web + Capacitor native; degrade gracefully when GPS is denied (user can still pick
  by hand).

## Non-goals (out of scope)

- Address search / geocoding (possible phase 2).
- Validating the point falls within city limits (separate issue if wanted).
- Any backend change: `create_report` already accepts `lng`/`lat`. This is
  client-only.

## Design

### Components

- **New `src/components/capture/LocationPicker.tsx`** (`"use client"`): a full-screen
  overlay / bottom-sheet that hosts a MapLibre map for choosing one point. It does
  **not** reuse `MapView.tsx` — that component is coupled to fetching reports, marker
  layers, and popups (a different responsibility). The two share only the MapLibre
  init pattern and the MapTiler `dataviz` style URL (`NEXT_PUBLIC_MAPTILER_KEY`).
- **`src/components/capture/CaptureForm.tsx`** location block changes: the current
  "Usar mi ubicación" (direct GPS) button is replaced by **"Elegir ubicación en el
  mapa"**, which opens `LocationPicker`. The existing `coords` state and submit
  validation are preserved.

### Interaction model — center pin (Uber/Rappi style)

- The map fills the picker. **The pin is a fixed CSS element centered over the map
  container** (a crosshair/pin overlay), NOT a MapLibre marker. The user drags the
  map underneath the pin.
- **The chosen coordinate is `map.getCenter()` at the moment of confirm.**
- Picker controls:
  - **"Usar mi ubicación"** — requests GPS via `getPosition()`; on success `flyTo`
    that point (the pin stays centered, so the chosen point becomes the GPS point
    until the user pans). On failure, a quiet inline note; the user can still pan.
  - **"Confirmar"** — reads `map.getCenter()`, returns `{ lat, lng }` to the form,
    closes the picker.
  - **"Cancelar"** — closes without changing anything.

### Initial centering when the picker opens

In priority order:
1. If `CaptureForm` already has `coords` (a previous pick), center there.
2. Else if a GPS fix is readily available, center there.
3. Else center on the city default (Bogotá — reuse `INITIAL_CENTER`/`INITIAL_ZOOM`
   constants, extracted to a shared module so `MapView` and `LocationPicker` agree).
A short hint tells the user to drag the map or use their location.

### Data flow

- `CaptureForm` owns `coords`. `LocationPicker` is controlled: it receives an
  `initialCenter` and an `onConfirm({lat,lng})` / `onCancel` callback.
- `coords` is set **only** on confirm. Cancel is a no-op.
- After confirm, the form shows **"Ubicación fijada: {lat}, {lng}"** plus a
  **"Cambiar"** action that reopens the picker.
- The `lng`/`lat` sent to `POST /api/reports` is the picked point.

### Error handling

- **GPS denied inside the picker**: inline note — "No pudimos obtener tu ubicación;
  mueve el mapa para fijar el punto." Non-blocking; manual pick still works.
- **No `coords` at submit**: existing validation stands — submit is blocked with the
  location-required message.
- **Map fails to initialize** (e.g. missing MapTiler key): the picker surfaces a
  readable error and the user can cancel; submit remains blocked (no silent success).

## Observable scenarios (SDD holdout)

> These become the holdout for `/scenario-driven-development`. File:
> `docs/specs/2026-05-31-stack-arquitectura/scenarios/location-picker.scenarios.md`.

- **SCEN-001 (E1 — pick a point that is not the GPS location):**
  Given the capture form and the location picker open, **When** the user drags the map
  so a point different from their device GPS is under the center pin and taps
  "Confirmar", **Then** the form shows "Ubicación fijada: {lat}, {lng}" with the
  picked point, and a subsequent `POST /api/reports` sends that point's `lng`/`lat`
  (NOT the GPS coordinates).

- **SCEN-002 ("use my location" is a starting point, not the final value):**
  Given the picker open, **When** the user taps "Usar mi ubicación" (GPS resolves) and
  then pans the map before confirming, **Then** the confirmed coordinate is the panned
  center, not the original GPS fix.

- **SCEN-003 (cancel is a no-op):**
  Given the form already has a confirmed location, **When** the user opens the picker,
  pans, and taps "Cancelar", **Then** `coords` is unchanged and the form still shows
  the previously confirmed point.

- **SCEN-004 (submit still blocked without a location):**
  Given the form with no location chosen, **When** the user submits, **Then** the
  submit is blocked with the location-required message and no `POST /api/reports` call
  is made.

- **SCEN-005 (GPS denied — manual pick still works):**
  Given the picker open and GPS permission denied, **When** the user taps "Usar mi
  ubicación", **Then** a non-blocking note appears and the user can still pan + confirm
  a point that is accepted by the form.

- **SCEN-006 (runtime, web): the picker works in a real browser, console clean:**
  Given `/reportar` in a real browser, **When** the user opens the picker, pans,
  confirms, and submits a complete report, **Then** the report is created with the
  picked coordinates (verifiable via DB / map) and the page has zero console errors and
  no failed requests.

## Testing strategy

- **Unit (`LocationPicker`)**: mock MapLibre (`map.getCenter`, `flyTo`, `on`) and
  `getPosition`. Assert: confirm returns `getCenter()`; cancel does not call
  `onConfirm`; "usar mi ubicación" calls `flyTo` with the GPS point; GPS error shows
  the note without throwing.
- **Unit (`CaptureForm`)**: with no coords, submit is blocked and no `fetch`; after a
  simulated confirm, the `POST /api/reports` body carries the picked point; "Cambiar"
  reopens the picker. Precise assertions (no loose matchers).
- **Runtime (agent-browser)**: SCEN-006 — drive `/reportar`, open picker, pan, confirm,
  submit; verify the created report's coordinates and a clean console.

## Files affected / blast radius

- **New**: `src/components/capture/LocationPicker.tsx`,
  `src/components/capture/LocationPicker.test.tsx`,
  `docs/specs/2026-05-31-stack-arquitectura/scenarios/location-picker.scenarios.md`.
- **Modified**: `src/components/capture/CaptureForm.tsx` (location block + state wiring),
  `src/components/capture/CaptureForm.test.tsx` (location flow), `src/app/globals.css`
  (picker styles), and a small shared module for `INITIAL_CENTER`/`INITIAL_ZOOM`
  (extracted from `MapView.tsx`; `MapView` updated to import it).
- **Consumers**: only `/reportar`. No API, DB, or migration changes.
- **Docs**: this spec + the scenarios file.
