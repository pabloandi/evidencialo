---
name: video-sanitize
created_by: orchestrator
created_at: 2026-06-03T00:00:00Z
step: 09
---

# Scenarios — sanitize-video Edge Function (Deno)

The client uploads the raw video (mp4) straight to the private `report-media`
bucket via the step05 signed URL, then invokes the `sanitize-video` Supabase Edge
Function with `{ report_id, media_id }`. The function (Deno, service-role)
downloads the raw object, **strips container-level location/metadata** (the mp4
`moov/udta` and `moov/meta` boxes carry GPS `©xyz` ISO-6709 PII) WITHOUT
transcoding (ffmpeg is unavailable in the Edge runtime; a pure box-rewrite fits
the limits and the PII lives in the container, not the frames), overwrites the
object, and marks `report_media.processing_state`. Visibility is decided by the
step08 trigger. Failure taxonomy mirrors step07: a corrupt/unsanitizable video is
a terminal `failed`; transient I/O (download/upload) is retried with backoff and
only `failed` after exhausting attempts; the report never publishes while a media
is pending/failed.

Verification split: the portable, privacy-critical pieces (`stripMp4Metadata`,
`withRetry`) are unit-tested in vitest using REAL ffmpeg/ffprobe (available
locally) to mint and inspect fixtures; the integrated state machine + visibility
is exercised via `supabase functions serve` + an invoke against the local stack.

---

## SCEN-001: a sanitized video publishes its report (E1 closure)
**Given**: a report whose only media is a video, `processing_state = 'pending'`, `is_visible = false`, with a valid mp4 uploaded to its `storage_path`
**When**: the `sanitize-video` function processes it and marks the media `'processed'`
**Then**: the media is `'processed'` and the report becomes `is_visible = true` (via the step08 trigger)
**Evidence**: integration (`supabase functions serve` + invoke against local DB/Storage) — `report_media.processing_state = 'processed'` AND `reports.is_visible = true` after the call

## SCEN-002: a video that cannot be sanitized ends 'failed' and never publishes (E10)
**Given**: a report whose only media is a video whose stored object is corrupt / not a parseable mp4
**When**: the function attempts to sanitize it (the sanitize step is deterministic — a corrupt container is not retried)
**Then**: the media ends `processing_state = 'failed'`, the report stays `is_visible = false`, and the failure is logged for panel review
**Evidence**: integration — `report_media.processing_state = 'failed'`, `reports.is_visible = false`; the function logs/returns a structured error (status ≥ 400)

## SCEN-003: container location metadata is stripped from the stored video (privacy)
**Given**: an mp4 whose container carries a location tag (GPS `©xyz`, e.g. `+40.0-074.0/`)
**When**: `stripMp4Metadata` processes its bytes
**Then**: the output is a valid, playable mp4 whose container exposes NO location/GPS metadata
**Evidence**: vitest — `ffprobe` on the INPUT fixture reports the location tag (non-vacuous); `ffprobe` on the OUTPUT reports no location tag; `ffprobe` confirms the output still has its video stream (not corrupted)

## SCEN-004: re-invoking sanitize on an already-processed video is idempotent
**Given**: a video media row already `'processed'` by a prior sanitize call
**When**: the same `{ report_id, media_id }` invoke is retried
**Then**: the response is success (200), the row stays `'processed'`, and no duplicate media row is created
**Evidence**: integration — `SELECT count(*)` for that `(report_id, storage_path)` is `1`; second call returns 200 / processed

## SCEN-005: transient I/O is retried with backoff, persistent failure gives up
**Given**: the `withRetry` helper wrapping a flaky operation
**When**: the operation fails transiently on the first attempt(s) but succeeds within the attempt budget — versus failing on every attempt
**Then**: in the heal case it returns the success value (no `failed`); in the persistent case it throws after exhausting the budget (so the caller marks `failed`)
**Evidence**: vitest — a stub failing once then succeeding resolves via `withRetry` (asserting it was retried); a stub always failing rejects after exactly N attempts
