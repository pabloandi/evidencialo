---
name: public-report-detail
created_by: orchestrator
created_at: 2026-06-05T00:00:00Z
step: 12
note: Public report detail page `/reportes/[id]`. Reached from a map marker. Shows a VISIBLE report's processed (sanitized) media, category, status, date, description. Non-visible or unknown id -> 404. Media is served from the PRIVATE `report-media` bucket via short-lived signed URLs minted server-side (service-role) in an ISR-cached RSC. Server-arbitrated scenarios run as unit/integration; the render + 404 + map→detail navigation are arbitrated by /agent-browser.
---

# Scenarios — public report detail

The detail page completes the public read path: a citizen taps a marker and lands
on `/reportes/[id]`, which shows the report's sanitized media, category, status,
date and description — but ONLY when the report is visible. It exposes no
`reporter_id` and no precise street address, and it serves media from the private
bucket via signed URLs (never a public/guessable object path).

---

## SCEN-001: a visible report renders its detail
**Given**: a report with `is_visible = true`, a category, a status, a created date, a description, and one `processed` image
**When**: its detail page `/reportes/[id]` is opened
**Then**: the page shows the category (Spanish label), the status (Spanish label), the date, the description, and the image
**Evidence**: integration — `getPublicReportDetail(id)` returns `{ category, status, createdAt, description, media: [{ signedUrl, type }] }`; runtime — the page DOM shows those fields and the `<img>` loads (200)

## SCEN-002: a non-visible report is not accessible (404)
**Given**: a report with `is_visible = false`
**When**: its detail page is opened
**Then**: the page responds 404 (`notFound`) — the hidden report is indistinguishable from a non-existent one (its existence is not leaked)
**Evidence**: integration — `getPublicReportDetail(id)` returns `null` for the invisible report; runtime — `/reportes/<invisibleId>` renders the 404 page

## SCEN-003: an unknown id is 404
**Given**: an id that matches no report (or a malformed id)
**When**: `/reportes/[id]` is opened
**Then**: the page responds 404, with no server error
**Evidence**: integration — `getPublicReportDetail(unknownId)` returns `null`; runtime — `/reportes/<random-uuid>` → 404

## SCEN-004: only processed (sanitized) media is shown
**Given**: a visible report whose media set includes a `pending` and/or `failed` item alongside a `processed` one
**When**: the detail loads its media
**Then**: only the `processed` media appears — `pending`/`failed` are excluded (no broken image, no unsanitized object)
**Evidence**: integration — the returned `media` array contains only the `processed` item(s)

## SCEN-005: media is served via signed URL; no PII leaks
**Given**: the detail of a visible report
**When**: the rendered output is inspected
**Then**: each media URL is a time-limited SIGNED URL to the private `report-media` object (not a public, guessable path), and the output carries NO `reporter_id` and no precise street address
**Evidence**: unit — the returned `signedUrl` is a signed storage URL (contains a token/expiry, points at the `report-media` object path) and the returned object has no `reporter_id` key

## SCEN-006 (runtime): the detail page renders with zero console errors
**Given**: a visible report with a processed image stored in the local `report-media` bucket
**When**: `/reportes/[id]` loads in a real browser
**Then**: the media renders (image request 200), and the console + network panels are clean (zero errors, zero failed requests; favicon aside)
**Evidence**: agent-browser — the `<img>` is present and loaded, console has zero errors, the signed media request is 200

## SCEN-007 (map → detail): a marker popup links to the detail
**Given**: the public map with a painted marker for a visible report
**When**: the user opens the marker popup and activates its "Ver detalle" link
**Then**: the app navigates to that report's `/reportes/[id]` detail page
**Evidence**: agent-browser — the popup contains a link whose href is `/reportes/<id>`; activating it lands on the detail page
