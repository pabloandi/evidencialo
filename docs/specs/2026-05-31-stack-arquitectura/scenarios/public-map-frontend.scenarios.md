---
name: public-map-frontend
created_by: orchestrator
created_at: 2026-06-04T00:00:00Z
step: 11
note: FRONTEND scope (MapView + public map page). Sibling holdout to public-map-bbox.scenarios.md — SCEN-005 there is the runtime render arbiter; these add the observable frontend behaviors around it (pan refetch, public-only popup, missing-key fallback, truncation hint). Runtime scenarios are arbitrated by /agent-browser; the missing-key + data-shape logic is also unit-testable headless.
---

# Scenarios — public map frontend (MapView)

The public map (`/` → `app/(public)/page.tsx` + `components/map/MapView`) renders the
visible reports for the current viewport using MapLibre GL v5 with a MapTiler base
style. It reads `GET /api/reports?bbox=…` on load and whenever the viewport moves,
paints one marker per visible report, and exposes only public fields. It degrades
gracefully when the MapTiler key is absent. These hold alongside SCEN-005.

---

## SCEN-F01: panning the map refetches the new viewport's bbox
**Given**: the map has loaded and issued an initial `GET /api/reports?bbox=…` for the start viewport
**When**: the user pans/zooms so the visible bounds change (a `moveend`)
**Then**: a NEW `GET /api/reports?bbox=…` is issued with the new bounds' coordinates (not the old ones), and the painted markers update to that response
**Evidence**: agent-browser — the network panel shows a second `/api/reports` request whose `bbox` query differs from the first; markers reflect the new data

## SCEN-F02: a marker popup exposes only public fields
**Given**: a painted marker for a visible report
**When**: the user clicks it
**Then**: the popup shows category, status, and date — and NEVER `reporter_id` or a precise street address (the API never sends them; the UI must not invent or request them)
**Evidence**: agent-browser — the popup DOM contains category/status/date text and no reporter identity; the marker's feature properties are exactly the public set

## SCEN-F03: the page degrades gracefully without a MapTiler key
**Given**: `NEXT_PUBLIC_MAPTILER_KEY` is unset (e.g. a fresh clone before secrets are configured)
**When**: the public map page loads
**Then**: the page renders a friendly fallback (a message, not a blank/broken screen) with NO uncaught exception and NO console error — the map simply cannot initialize, and the app says so
**Evidence**: agent-browser (or unit on the gating logic) — the fallback element is present, the console has zero errors, and no MapLibre/WebGL crash is thrown

## SCEN-F04: a truncated viewport tells the user to zoom in
**Given**: a dense viewport where the bbox response carries `X-Result-Truncated: true`
**When**: the markers are painted
**Then**: the UI shows a non-blocking hint inviting the user to zoom in for the rest (the truncation is surfaced, not silent) — and when the header is absent, no hint is shown
**Evidence**: agent-browser / unit — with the header present a hint element appears; without it, the hint is absent

## SCEN-005 (cross-ref — public-map-bbox.scenarios.md)
The canonical render arbiter (map paints visible markers with zero console errors,
zero failed requests) lives in `public-map-bbox.scenarios.md`. It is verified here
in the frontend phase with `/agent-browser` once `NEXT_PUBLIC_MAPTILER_KEY` is set.
