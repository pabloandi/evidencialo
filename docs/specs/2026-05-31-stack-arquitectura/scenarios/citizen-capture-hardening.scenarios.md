---
name: citizen-capture-hardening
created_by: orchestrator
created_at: 2026-06-07T00:00:00Z
step: 15
note: Hardening for the anonymous Turnstile path in CaptureForm. Observed at runtime in production — Cloudflare's own console warns "Cannot find Widget cf-chl-widget-XXX, consider using turnstile.remove() to clean up a widget." The widget-loading effect renders a Turnstile widget but discards the returned widget id, never removes it on teardown, and re-appends a fresh api.js <script> on every effect run. This leaks widgets and script tags across unmount / needsCaptcha toggles. Sibling to citizen-capture.scenarios.md (SCEN-001..005 cover the happy submit path; these cover lifecycle cleanup).
---

# Scenarios — citizen capture hardening (Turnstile lifecycle)

The anonymous capture form mounts a Cloudflare Turnstile widget. The widget owns
DOM and Cloudflare-internal state that must be released when the form unmounts or
the captcha is no longer needed — otherwise Cloudflare logs orphaned-widget
warnings and stale `<script>` tags accumulate. These scenarios pin the cleanup
contract so the happy path (SCEN-001/004) stays leak-free.

---

## SCEN-006: the Turnstile widget is cleaned up on unmount
**Given**: an anonymous capture form (no Supabase session) with a Turnstile sitekey configured, that has rendered a Turnstile widget via `window.turnstile.render(container, …)` returning a widget id
**When**: the form unmounts (or `needsCaptcha` flips false because the captcha is no longer needed)
**Then**: the effect's cleanup calls `window.turnstile.remove(widgetId)` with the exact id returned at render time, guarded so a missing id / missing `remove` / Turnstile-internal throw never breaks React teardown — leaving no orphaned `cf-chl-widget` and no Cloudflare "Cannot find Widget" warning
**Evidence**: unit — with a mocked `window.turnstile = { render: () => "widget-id-1", remove }`, after the anonymous form mounts `render` is called once and after `unmount()` `remove` is called once with `"widget-id-1"`

## SCEN-007: the api.js script tag is not duplicated on re-render
**Given**: an anonymous capture form whose Turnstile effect injects `…/turnstile/v0/api.js` because `window.turnstile` is not yet defined
**When**: the effect runs again (re-render / remount) while a matching api.js `<script>` already exists in the document
**Then**: the existing script is reused (its load listener is attached) instead of appending a second tag — exactly one `script[src*="turnstile/v0/api.js"]` exists, and the existing `childElementCount === 0` render guard still prevents a double `render`
**Evidence**: unit — after a mount that injects the script followed by a re-render, the document contains exactly one Turnstile api.js script tag
