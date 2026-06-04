---
name: public-map-bbox
created_by: orchestrator
created_at: 2026-06-03T00:00:00Z
step: 11
note: BACKEND scope (bbox read API). The MapView render scenario (SCEN-005) is verified in the frontend phase with agent-browser once NEXT_PUBLIC_MAPTILER_KEY is set.
---

# Scenarios — public map by bounding box

The public map reads visible reports within the current viewport's bounding box.
`GET /api/reports?bbox=minLng,minLat,maxLng,maxLat` calls a PostGIS function that
uses the GIST index (`location && ST_MakeEnvelope(...)`) and returns ONLY
`is_visible=true` reports, with public fields only (no reporter_id / no precise
address — coordinates are already public by nature of a pin). Reads are cacheable
and never touch the write path.

---

## SCEN-001: bbox returns only the visible reports inside the box (E8)
**Given**: two visible reports — A at (lng -74.08, lat 4.61) INSIDE the requested box, and B at (lng -75.50, lat 6.25) OUTSIDE it
**When**: `GET /api/reports?bbox=-74.10,4.60,-74.06,4.62`
**Then**: the response contains report A and NOT report B
**Evidence**: integration — the JSON array contains A's id and excludes B's id

## SCEN-002: an invisible report inside the box is excluded (E2)
**Given**: a report `is_visible=false` located INSIDE the requested box
**When**: the bbox query runs
**Then**: that report is NOT in the response
**Evidence**: integration — the invisible report's id is absent from the result

## SCEN-003: a malformed or over-large bbox is rejected
**Given**: a request with a missing/malformed `bbox` (e.g. 3 numbers, non-numeric, min>max) OR a bbox spanning more than a sane maximum area (anti-abuse — a whole-world query)
**When**: `GET /api/reports` receives it
**Then**: the response is `400` with a structured `{ error: { code, message } }`; no unbounded scan runs
**Evidence**: HTTP 400 response body JSON for each malformed/oversized case

## SCEN-004: the response exposes only public fields
**Given**: a visible report inside the box that has a `reporter_id` and an `address`
**When**: it is returned by the bbox query
**Then**: each item carries `id`, `lng`, `lat`, `category` (slug or id), `status`, `created_at` — and NOT `reporter_id` (and not a precise street `address` beyond what the design intends to expose)
**Evidence**: integration — the returned object keys are exactly the public set; `reporter_id` is absent

## SCEN-005 (frontend phase): the public map paints visible markers with zero console errors
**Given**: the bbox API returns visible reports for the initial viewport
**When**: the public map page (`app/(public)/page.tsx` + `MapView`) loads in a real browser with a valid `NEXT_PUBLIC_MAPTILER_KEY`
**Then**: the MapLibre map renders the MapTiler base tiles and paints a marker per returned report, with ZERO console errors and ZERO failed network requests (favicon aside)
**Evidence**: agent-browser — DOM shows the map canvas + markers; console + network panels clean. (Verified in the frontend phase, not this backend holdout.)
