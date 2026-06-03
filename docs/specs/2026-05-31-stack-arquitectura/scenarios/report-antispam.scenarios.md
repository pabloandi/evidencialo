---
name: report-antispam
created_by: orchestrator
created_at: 2026-06-02T00:00:00Z
step: 06
---

# Scenarios — rate-limit (Upstash) + captcha (Turnstile) on POST /api/reports

Anonymous submission is the spam surface. Two server-side gates protect it, in
this order (design §5.2): **rate-limit first** (cheap Redis check, by user id if
authenticated else by client IP), then **captcha** (only for anonymous callers;
a session is its own proof of humanity). Authenticated callers never see a
captcha. The Turnstile token travels in the `cf-turnstile-response` request
header.

Decisions encoded here: rate-limit **fails open** (a Redis outage must not take
the endpoint down — captcha still walls anonymous writes); captcha **fails
closed** (a siteverify network error denies, since it is the anti-spam wall).

Baseline valid body = the SCEN from report-create (category "bache", valid
coords, one image). "Under the limit" means the limiter reports `success: true`.

---

## SCEN-001: anonymous over the rate-limit window is rejected with 429 (E6)
**Given**: an anonymous client (no session) from IP `203.0.113.5` that has already consumed its allowed submissions in the window (the limiter reports `success: false` for that identifier)
**When**: it sends one more valid `POST /api/reports` (even with a valid captcha token)
**Then**: the response is `429` with body `{ "error": { "code": "rate_limited", "message": "Has enviado demasiados reportes. Espera unos minutos." } }`; no report is created
**Evidence**: HTTP 429 response body JSON; the report-creation service was never invoked (no new `reports` row for this attempt)

## SCEN-002: anonymous with a missing captcha token is rejected with 403
**Given**: an anonymous client under the rate limit that sends NO `cf-turnstile-response` header
**When**: it sends a valid `POST /api/reports`
**Then**: the response is `403` with `error.code` `"captcha_required"` and a Spanish `error.message`; no report is created
**Evidence**: HTTP 403 response body JSON; no `reports` row created

## SCEN-003: anonymous with an invalid captcha token is rejected with 403
**Given**: an anonymous client under the rate limit whose `cf-turnstile-response` token fails Turnstile siteverify (`success: false`)
**When**: it sends a valid `POST /api/reports`
**Then**: the response is `403` with `error.code` `"captcha_invalid"` and a Spanish `error.message`; no report is created
**Evidence**: HTTP 403 response body JSON; siteverify was called and returned `success:false`; no `reports` row created

## SCEN-004: anonymous with a valid captcha under the limit succeeds
**Given**: an anonymous client under the rate limit whose `cf-turnstile-response` token passes Turnstile siteverify (`success: true`)
**When**: it sends a valid `POST /api/reports`
**Then**: the response is `201` and a report is created (the normal create path runs)
**Evidence**: HTTP 201 response body with `report_id`; a `reports` row exists with `is_visible=false`

## SCEN-005: an authenticated citizen under the limit needs no captcha
**Given**: a citizen WITH a valid session, under the rate limit, sending NO `cf-turnstile-response` header
**When**: it sends a valid `POST /api/reports`
**Then**: the response is `201` and a report is created; Turnstile siteverify is NEVER called (sessions are exempt from captcha)
**Evidence**: HTTP 201 response body with `report_id`; no outbound siteverify request was made

## SCEN-006: rate-limit is evaluated before captcha
**Given**: an anonymous client that is OVER the rate limit AND presents a valid captcha token
**When**: it sends `POST /api/reports`
**Then**: the response is `429` (rate_limited) — not `403` — because the rate-limit gate runs first
**Evidence**: HTTP 429 (not 403) response body JSON

## SCEN-007: a Turnstile siteverify network failure fails closed (403)
**Given**: an anonymous client under the limit with a token present, but the siteverify HTTP call throws / times out
**When**: it sends `POST /api/reports`
**Then**: the response is `403` (captcha denied on error — fail closed); no report is created
**Evidence**: HTTP 403 response body JSON; the thrown siteverify error is logged server-side; no `reports` row created

## SCEN-008: a rate-limit backend failure fails open (request proceeds)
**Given**: the Upstash limiter call throws (Redis/REST outage) for an otherwise valid submission
**When**: it sends `POST /api/reports`
**Then**: the request is NOT rejected with 429/500 by the rate-limit gate — it proceeds to the captcha/validation/create path as if allowed; the limiter error is logged
**Evidence**: server log records the limiter failure; the response is whatever the downstream gates produce (e.g. 201 for an authenticated valid submission), never a 500 caused by the limiter
