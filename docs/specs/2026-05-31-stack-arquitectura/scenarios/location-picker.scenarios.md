---
name: location-picker
created_by: brainstorming
created_at: 2026-06-08T00:00:00Z
issue: https://github.com/pabloandi/evidencialo/issues/1
spec: docs/specs/2026-06-08-location-picker-design.md
note: A citizen chooses the report's location on a map (center-pin, drag-the-map) in a dedicated picker, instead of only the device GPS. "Usar mi ubicación" is a convenience shortcut (a starting point), not the final value. The picked point = map.getCenter() on confirm. Client-only; create_report already accepts lng/lat. Web + Capacitor; degrades when GPS is denied.
---

# Scenarios — location picker (LocationPicker + CaptureForm)

The report's location must describe the **problem**, not where the citizen happens to
be when they submit. The picker lets them place/adjust a point on a map; GPS is only a
shortcut to center it.

---

## SCEN-001 (E1): pick a point that is not the GPS location
**Given**: the capture form and the location picker open, with the map centered somewhere
**When**: the user drags the map so a point DIFFERENT from their device GPS is under the center pin, then taps "Confirmar"
**Then**: the form shows `Ubicación fijada: {lat}, {lng}` with the picked point (5-decimal format), and a subsequent `POST /api/reports` sends that point's `lng`/`lat` — NOT the GPS coordinates
**Evidence**: unit — `onConfirm` returns `map.getCenter()`; the CaptureForm submit body carries the picked point. agent-browser — full submit lands a report at the picked coords.

## SCEN-002: "use my location" is a starting point, not the final value
**Given**: the picker open
**When**: the user taps "Usar mi ubicación" (GPS resolves), then pans the map before confirming
**Then**: the confirmed coordinate is the panned center, not the original GPS fix
**Evidence**: unit — "usar mi ubicación" calls `flyTo(gps)`; after a simulated pan, confirm returns the new center, not the GPS point.

## SCEN-003: cancel is a no-op
**Given**: the form already has a confirmed location
**When**: the user opens the picker, pans, and taps "Cancelar"
**Then**: `coords` is unchanged and the form still shows the previously confirmed point
**Evidence**: unit — cancel does not call `onConfirm`; CaptureForm `coords` unchanged after cancel.

## SCEN-004: submit still blocked without a location
**Given**: the form with no location chosen
**When**: the user submits
**Then**: the submit is blocked with the location-required message and NO `POST /api/reports` call is made
**Evidence**: unit — with no coords, the submit handler short-circuits (no fetch) and surfaces the message.

## SCEN-005: GPS denied — manual pick still works
**Given**: the picker open and GPS permission denied
**When**: the user taps "Usar mi ubicación"
**Then**: a non-blocking note appears ("No pudimos obtener tu ubicación; mueve el mapa para fijar el punto") and the user can still pan + confirm a point that the form accepts
**Evidence**: unit — a rejected `getPosition()` sets the note without throwing; confirm still works afterward.

## SCEN-006 (runtime, web): the picker works in a real browser, console clean
**Given**: `/reportar` in a real browser
**When**: the user opens the picker, pans, confirms, and submits a complete report
**Then**: the report is created with the PICKED coordinates (verifiable via DB / the public map) and the page has ZERO console errors and no failed requests (favicon aside)
**Evidence**: agent-browser — the picker opens, pans, confirms; the submit chain runs clean; the created report's coords match the picked point.
