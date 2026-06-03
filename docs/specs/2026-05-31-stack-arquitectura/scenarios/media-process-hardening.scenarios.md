---
name: media-process-hardening
created_by: orchestrator
created_at: 2026-06-02T00:00:00Z
step: 07
note: additive scenarios from the step07 quality review (edge-case + performance agents). Sibling holdout to media-process.scenarios.md — does not modify it.
---

# Scenarios — media-process hardening (review findings)

Refines the failure taxonomy and resource limits of `POST /api/media`. These
must hold alongside the originals (SCEN-001..007), never weakening them.

---

## SCEN-H01: an oversized / decompression-bomb image is rejected without OOM, marked failed
**Given**: a `report_media` raw object that is either > 10 MB of bytes or whose pixel dimensions exceed the processor's cap (~50 MP), i.e. a decompression bomb
**When**: `POST /api/media` tries to process it
**Then**: the function does NOT exhaust memory; the image is treated as a processing failure — the row's `processing_state` becomes `'failed'` and the response is `>= 400` with a structured error; the parent report stays `is_visible = false`
**Evidence**: DB row `processing_state = 'failed'`; no OOM/crash (the request returns a structured error, not a process kill); report `is_visible` still false

## SCEN-H02: a transient storage/DB write error leaves the media RETRYABLE (pending), not terminally failed
**Given**: a decodable image whose `stripExifCompress`/`makeThumbnail` SUCCEED, but a storage upload or the DB state-update then fails transiently (injected error)
**When**: `POST /api/media` hits that write failure
**Then**: the row is NOT marked `'failed'` — it remains `'pending'` (a retryable state, since the upload is idempotent via upsert); the response signals a retryable error (`>= 500` or a retry status). A subsequent retry with storage healthy reaches `'processed'`.
**Evidence**: after the injected write failure, `report_media.processing_state = 'pending'` (NOT 'failed'); a follow-up successful run yields `'processed'`. Only a DECODE error (SCEN-007) is terminal `'failed'`.

## SCEN-H03: the processed object's stored format matches its storage_path extension
**Given**: a raw upload whose `storage_path` extension is `.webp` (or `.png`) — formats step05 allows
**When**: `POST /api/media` processes it
**Then**: the object stored at `storage_path` is NOT JPEG bytes mislabeled under a `.webp`/`.png` path; the stored bytes' actual image format matches the path extension and the upload's content-type
**Evidence**: download the processed object; `sharp(buffer).metadata().format` matches the `storage_path` extension; the object's content-type is consistent with that format

## SCEN-H04: a media row whose raw object was never uploaded is treated as not-ready, not a crash
**Given**: a `report_media` row in `'pending'` whose object does NOT exist at `storage_path` (the client abandoned the signed upload)
**When**: `POST /api/media` is called for it
**Then**: the response is a distinct retryable/not-ready status (NOT a generic 500 `internal_error`); the row stays `'pending'` (not flipped to `'failed'`), so a later retry after the upload completes can still process it
**Evidence**: HTTP response is a clear not-ready/retryable status with a structured error; `report_media.processing_state` is still `'pending'`
