---
name: media-process
created_by: orchestrator
created_at: 2026-06-02T00:00:00Z
step: 07
---

# Scenarios — POST /api/media: EXIF strip + compress + thumbnail

Architecture note (updates design §5.3, per the step05 decision recorded in
guardrails `fix-20260602-write-path-signed-upload`): the client uploads the RAW
image straight to the PRIVATE `report-media` bucket via the signed upload URL
issued at report creation. It then calls `POST /api/media` with
`{ report_id, media_id }` to trigger server-side processing. The handler (Node
runtime, service-role) downloads the raw object, **strips all EXIF (including GPS
geolocation PII)**, auto-orients, compresses, writes the processed image back
over the same `storage_path`, generates a thumbnail at a derived path, and marks
`report_media.processing_state`. Privacy holds because the bucket is private and
`reports.is_visible` stays false until the step08 trigger flips it once all media
is `processed`. A raw image with EXIF is never publicly reachable.

Test fixtures use `sharp(...).withExif({ GPS: {...} })` to embed GPS, and
`exif-reader` (or sharp `metadata().exif`) to assert presence/absence.

---

## SCEN-001: a stored image with GPS EXIF is stripped of all localization metadata (E1, partial)
**Given**: a `report_media` image row whose raw object at `storage_path` (e.g. `<report_id>/0.jpg`) embeds GPS EXIF (a real latitude/longitude)
**When**: `POST /api/media` with `{ report_id, media_id }` processes it
**Then**: the object now stored at `storage_path` is a valid, decodable image that contains NO GPS/localization EXIF (and ideally no EXIF block at all)
**Evidence**: download the processed object via service-role; parsing its EXIF yields no GPS tags (the input fixture's EXIF DID contain GPS); `sharp(buffer).metadata()` still returns valid `width`/`height` (image is intact)

## SCEN-002: a successfully processed image is marked `processed`
**Given**: a valid raw image at `storage_path`
**When**: `POST /api/media` finishes successfully
**Then**: the `report_media` row has `processing_state = 'processed'` and its `width`/`height` are populated from the image
**Evidence**: DB row `report_media.processing_state = 'processed'`, `width > 0`, `height > 0`; HTTP 200

## SCEN-003: a retried process call does not duplicate media and stays processed (idempotent)
**Given**: a `report_media` row already processed once by `POST /api/media`
**When**: the identical `POST /api/media` with the same `{ report_id, media_id }` is retried
**Then**: the response is 200, the row remains `processed`, and there is still exactly ONE `report_media` row for that `(report_id, storage_path)` — no duplicate media is created
**Evidence**: `SELECT count(*) FROM report_media WHERE report_id = $1 AND storage_path = $2` returns `1` after the retry; second HTTP 200

## SCEN-004: a thumbnail is generated at a deterministic derived path
**Given**: a successfully processed image at `storage_path`
**When**: processing completes
**Then**: a thumbnail object exists at the deterministic derived path (e.g. `<report_id>/0.thumb.webp`), is a valid image, and its largest dimension is ≤ 400 px
**Evidence**: download the thumbnail object via service-role; `sharp(buffer).metadata()` returns a valid image with `max(width, height) <= 400`

## SCEN-005: an invalid request body is rejected without processing
**Given**: a `POST /api/media` with a missing or non-UUID `report_id` or `media_id`
**When**: it reaches the handler
**Then**: the response is `422` with a structured `{ error: { code, message } }` (Spanish message) and nothing is processed or written to storage
**Evidence**: HTTP 422 response body JSON; no storage write occurred

## SCEN-006: a media id that does not exist (or belongs to another report) is rejected
**Given**: a `POST /api/media` whose `media_id` is not found, or whose `media_id` does not belong to the given `report_id`
**When**: it reaches the handler
**Then**: the response is `404` with a structured error; nothing is processed
**Evidence**: HTTP 404 response body JSON; `processing_state` of any real row is unchanged

## SCEN-007: an undecodable raw object marks the media `failed`, keeping the report invisible
**Given**: a `report_media` row whose raw object at `storage_path` is not a decodable image (corrupt bytes)
**When**: `POST /api/media` tries to process it
**Then**: the response is an error (`>= 400`, not a crash); the row's `processing_state` becomes `'failed'` (never `'processed'`); the parent report stays `is_visible = false`
**Evidence**: DB row `report_media.processing_state = 'failed'`; the report's `is_visible` is still `false`; HTTP status ≥ 400 with a structured error body
