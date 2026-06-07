---
name: citizen-capture
created_by: orchestrator
created_at: 2026-06-05T00:00:00Z
step: 15
note: The citizen capture UI (CaptureForm + /reportar) — the app's core action, previously missing. A citizen takes a photo, sets category/description/location, and submits. Flow: POST /api/reports → upload raw bytes to the returned signed upload URL → POST /api/media (strip EXIF + process) → the visibility trigger makes the report public. Native camera/GPS (Capacitor) layer behind isNativePlatform() with web-API fallback. The APK build is the Phase B / Android-SDK acceptance (not runnable in this sandbox). Web flow + abstraction are unit + agent-browser arbitrated.
---

# Scenarios — citizen capture (CaptureForm + Capacitor shell)

A citizen reports an urban problem: a photo, a category, a short description, and a
location, sent to the same API the whole app is built around. On Android (Capacitor)
the photo and GPS come from native plugins; in a browser they come from web APIs —
one codebase, one submit path.

---

## SCEN-001 (E1): a complete submission creates a report and becomes visible
**Given**: a citizen on the capture form with a photo, a category, a description, and a location
**When**: they submit
**Then**: `POST /api/reports` succeeds (201) returning the report id + signed media upload; the photo's raw bytes are uploaded to that signed URL; `POST /api/media` processes it (EXIF/GPS stripped); after processing the report is visible and appears on the public map
**Evidence**: agent-browser — the submit chain returns 201 then a 200 from /api/media; the created report (id) shows up via the bbox read / on the map once processed; the stored object is the processed (sanitized) version

## SCEN-002: an incomplete submission is blocked client-side
**Given**: the capture form missing a photo, or a category, or a location
**When**: the user tries to submit
**Then**: the form blocks the submit with a clear message and does NOT call `POST /api/reports`
**Evidence**: unit/agent-browser — with a missing required field the submit handler short-circuits (no network call) and surfaces the validation message

## SCEN-003: capture uses native plugins on device, web APIs in a browser
**Given**: the `capture` abstraction (`capturePhoto`/`getPosition`)
**When**: it runs under Capacitor (`isNativePlatform()` true) vs in a browser (false)
**Then**: native uses `@capacitor/camera` / `@capacitor/geolocation`; web uses the file input / `navigator.geolocation` — same return shape either way
**Evidence**: unit — mocking `isNativePlatform()` true vs false selects the native vs web path and both yield a photo File + a {lat,lng}

## SCEN-004 (runtime): the form renders and a web submit lands a report, console clean
**Given**: the `/reportar` page in a real browser (a signed-in citizen, captcha-exempt)
**When**: the form is filled and submitted
**Then**: the report is created and ends up visible (map / "mis reportes"); the page has ZERO console errors and no failed requests (favicon aside)
**Evidence**: agent-browser — the full chain runs clean; the report appears in the citizen's `/mis-reportes`

## SCEN-005 (Capacitor shell): the app can be wrapped as an Android build
**Given**: `capacitor.config.ts` with `server.url` pointing at production and the native capture behind `isNativePlatform()` with a web fallback
**When**: the Android project is generated and built in an environment with the Android SDK (`npx cap add android` + `gradle assembleDebug`)
**Then**: it produces an installable APK whose native capture submits through the same API (E1) — the web fallback path is what runs (and is verified) in this sandbox; the APK build + on-device native test are the Android-SDK (Phase B) acceptance
**Evidence**: config present + native/web branch unit-tested here; APK build + device test performed in an Android-SDK environment (documented commands), not in this sandbox
