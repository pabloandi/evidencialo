---
name: video-sanitize-hardening
created_by: orchestrator
created_at: 2026-06-03T00:00:00Z
step: 09
note: additive scenarios from the step09 quality review (edge-case HIGH recursion-depth + the not-ready contract gap vs step07). Sibling holdout to video-sanitize.scenarios.md.
---

# Scenarios — sanitize-video hardening (review findings)

Refinements to the failure taxonomy and parser robustness of the `sanitize-video`
function. Hold alongside SCEN-001..005, never weakening them.

---

## SCEN-H01: a missing raw object is treated as not-ready (retryable), not terminally failed
**Given**: a `report_media` video row in `'pending'` whose object does NOT exist at `storage_path` (the client invoked before completing the upload, or the path is wrong)
**When**: `sanitize-video` is invoked for it
**Then**: the response is a distinct not-ready/retryable status (NOT a generic retried-then-503), the download is NOT retried with backoff for a deterministic not-found, and the row stays `'pending'` (NOT flipped to `'failed'`) so a later retry after the upload completes can still process it — mirroring step07's `media_not_ready` (409)
**Evidence**: integration — invoking with a never-uploaded object returns 409 (not 503), and `report_media.processing_state` is still `'pending'` afterward

## SCEN-H02: a pathologically deep-nested mp4 fails cleanly without exhausting the runtime
**Given**: a byte stream that parses as a valid box tree but nests container boxes far deeper than any real mp4 (e.g. thousands of levels)
**When**: `stripMp4Metadata` processes it
**Then**: it throws a clean parse error at a sane depth bound (so the caller marks the media terminal `'failed'`) — it does NOT recurse until the call stack overflows / the isolate is stressed
**Evidence**: vitest — a crafted deep-nested buffer makes `stripMp4Metadata` throw a "nesting too deep" error well before a `RangeError: Maximum call stack size exceeded`, and a normal (shallow) mp4 still strips successfully
