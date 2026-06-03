---
name: report-create-hardening
created_by: orchestrator
created_at: 2026-06-02T00:00:00Z
step: 05
note: additive scenarios from the step05 quality review (edge-case + code-review agents). Sibling holdout to report-create.scenarios.md — does not modify it.
---

# Scenarios — report-create hardening (review findings)

The four quality-review agents surfaced correctness gaps in the first cut of the
write path. These scenarios encode the intended behavior for the fixes; the
implementation must satisfy them without weakening the originals.

---

## SCEN-010: a blank Idempotency-Key header is treated as "no key" (no cross-request collision)
**Given**: two unrelated valid baseline submissions, each sent with an empty `Idempotency-Key:` header (empty string), from different callers
**When**: both send `POST /api/reports`
**Then**: each gets `201` with its OWN distinct `report_id`; neither response carries the other's report id or upload URLs; the database holds two distinct `reports` rows
**Evidence**: two HTTP 201 responses whose `report_id` values differ; the two created `reports` rows have distinct ids and a NULL `idempotency_key` (a blank header key is never persisted as a shared key)

## SCEN-011: non-integer or non-positive numeric fields are rejected, nothing is created
**Given**: the baseline payload mutated to a malformed numeric — any of: `media[0].size = 30.5` (non-integer), `media[0].size = 0` (non-positive), or a video item with `duration_s = 45.7` (non-integer)
**When**: it sends `POST /api/reports` with header `Idempotency-Key: k-011`
**Then**: response is `422` with a structured `error` (a validation code such as `"invalid_payload"` or a specific media code — never `500`); no `reports` row is created for `k-011`
**Evidence**: HTTP 422 response body JSON; `SELECT count(*) FROM reports WHERE idempotency_key = 'k-011'` returns `0`

## SCEN-012: a failure midway through creation leaves no partial report (atomicity)
**Given**: a valid multi-media submission where the report row can be inserted but a media row insert is made to fail (simulated)
**When**: it sends `POST /api/reports`
**Then**: the response is an error (`>= 400`); the database holds NO report for that attempt and NO orphaned `report_media` rows — report+media creation is all-or-nothing
**Evidence**: post-failure `SELECT count(*)` over `reports` for the attempt's key is `0` and over `report_media` for any would-be `report_id` is `0` (verified via a transactional RPC that rolls back the whole unit on any failure)
