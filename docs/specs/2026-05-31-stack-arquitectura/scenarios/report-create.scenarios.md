---
name: report-create
created_by: orchestrator
created_at: 2026-06-02T00:00:00Z
step: 05
---

# Scenarios — reportService + POST /api/reports

Write boundary of the hybrid approach. The client declares its media up front
(so the server can enforce limits and pre-create rows); the server creates the
report invisible and returns one signed upload URL per media item to a private
Storage bucket. EXIF/metadata sanitization happens asynchronously after upload
(step07), not inline. Idempotency is enforced by a DB unique constraint on
`reports.idempotency_key` so a network retry never duplicates a report.

Valid baseline payload (referenced by SCENs):
```json
{
  "category": "bache",
  "lat": 4.6097,
  "lng": -74.0817,
  "description": "Bache profundo frente al colegio, peligroso para motos.",
  "media": [{ "type": "image", "mime": "image/jpeg", "size": 2000000 }]
}
```
Idempotency key travels in the `Idempotency-Key` request header.

---

## SCEN-001: valid submission is born invisible with a signed upload URL
**Given**: an anonymous client and the valid baseline payload, with header `Idempotency-Key: k-001`
**When**: it sends `POST /api/reports`
**Then**: response is `201`; body is `{ "report_id": <uuid>, "media": [{ "id": <uuid>, "type": "image", "upload": { "signedUrl": <https url>, "token": <string>, "path": <string> } }] }`; the persisted `reports` row has `is_visible = false`; the persisted `report_media` row has `processing_state = 'pending'`
**Evidence**: HTTP 201 response body JSON; DB row `reports.is_visible = false`; DB row `report_media.processing_state = 'pending'`

## SCEN-002: idempotent retry returns the same report, creates no duplicate (E11)
**Given**: the client already sent SCEN-001 successfully once with `Idempotency-Key: k-002` (exactly one report exists for that key)
**When**: the identical `POST /api/reports` with header `Idempotency-Key: k-002` is retried after a simulated network failure
**Then**: response is `200`; its `report_id` equals the `report_id` from the first attempt; the database holds exactly one `reports` row with `idempotency_key = 'k-002'`
**Evidence**: second HTTP response `report_id` string-equals the first; `SELECT count(*) FROM reports WHERE idempotency_key = 'k-002'` returns `1`

## SCEN-003: image over the size limit is rejected, nothing is created
**Given**: the baseline payload but `media[0].size = 12000000` (over the 10 MB image limit)
**When**: it sends `POST /api/reports` with header `Idempotency-Key: k-003`
**Then**: response is `422`; body is `{ "error": { "code": "media_too_large", "message": "La imagen supera el tamaño máximo de 10 MB.", "field": "media.0.size" } }`; no `reports` row is created for `k-003`
**Evidence**: HTTP 422 response body JSON; `SELECT count(*) FROM reports WHERE idempotency_key = 'k-003'` returns `0`

## SCEN-004: more than three images is rejected
**Given**: the baseline payload but `media` holds four `image/jpeg` items each `size = 1000000`
**When**: it sends `POST /api/reports`
**Then**: response is `422`; the body's `error.code` is `"too_many_images"` and `error.message` is `"Máximo 3 imágenes por reporte."`; no report is created
**Evidence**: HTTP 422 response body JSON; DB `reports` count for the request's key is `0`

## SCEN-005: disallowed image format is rejected
**Given**: the baseline payload but `media[0].mime = "image/gif"`
**When**: it sends `POST /api/reports`
**Then**: response is `422`; `error.code` is `"media_format_invalid"` and `error.message` is `"Formato de imagen no permitido. Usa JPEG, PNG o WebP."`
**Evidence**: HTTP 422 response body JSON

## SCEN-006: out-of-range coordinates are rejected
**Given**: the baseline payload but `lat = 200`
**When**: it sends `POST /api/reports`
**Then**: response is `422`; `error.code` is `"coordinates_out_of_range"` and `error.message` is `"Coordenadas fuera de rango."`
**Evidence**: HTTP 422 response body JSON

## SCEN-007: unknown category is rejected
**Given**: the baseline payload but `category = "inexistente"`
**When**: it sends `POST /api/reports`
**Then**: response is `422`; `error.code` is `"category_invalid"` and `error.message` is `"Categoría no válida."`; no report is created
**Evidence**: HTTP 422 response body JSON; DB `reports` count for the request's key is `0`

## SCEN-008: video over its limits is rejected
**Given**: the baseline payload but `media = [{ "type": "video", "mime": "video/mp4", "size": 60000000, "duration_s": 90 }]` (over the 50 MB and 60 s video limits)
**When**: it sends `POST /api/reports`
**Then**: response is `422`; `error.code` is one of `"media_too_large" | "video_too_long"` with a Spanish `error.message`; no report is created
**Evidence**: HTTP 422 response body JSON; DB `reports` count for the request's key is `0`

## SCEN-009: empty media is rejected (a report needs evidence)
**Given**: the baseline payload but `media = []`
**When**: it sends `POST /api/reports`
**Then**: response is `422`; `error.code` is `"media_required"` and `error.message` is `"Adjunta al menos una foto o video."`
**Evidence**: HTTP 422 response body JSON
