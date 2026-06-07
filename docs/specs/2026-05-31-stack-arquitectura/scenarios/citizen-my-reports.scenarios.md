---
name: citizen-my-reports
created_by: orchestrator
created_at: 2026-06-05T00:00:00Z
step: 14
note: The citizen "mis reportes" view (`/mis-reportes`) lists the signed-in user's OWN reports — including ones not yet public — via RLS `reports_select_own` (reporter_id = auth.uid()) on the user's server client (never the admin client). This depends on the create path ASSOCIATING the reporter: `create_report` gains `p_reporter_id` and the POST route passes the authenticated user id (anonymous capture stays anonymous = null). Backend scenarios run as unit/integration; the view + gate are arbitrated by /agent-browser with a real citizen session.
---

# Scenarios — citizen "mis reportes"

An account is optional in evidencialo, but a signed-in citizen can follow their own
reports and their status — including reports that are not yet publicly visible. This
view reads ONLY the user's own reports (RLS), behind a session gate.

---

## SCEN-001 (E5): a citizen sees their own non-visible report
**Given**: an authenticated citizen who has a report of their own with `is_visible = false`
**When**: they open `/mis-reportes`
**Then**: that report appears with its current status, even though it is not public yet
**Evidence**: agent-browser — after the citizen signs in, `/mis-reportes` lists the report and its status, marked as not-yet-visible

## SCEN-002: a citizen does NOT see other users' reports
**Given**: reports that belong to OTHER users (and anonymous reports)
**When**: the citizen opens `/mis-reportes`
**Then**: none of those appear — the list is exactly their own reports
**Evidence**: agent-browser/integration — the list contains the citizen's report ids and excludes a foreign report id; the read is RLS-scoped (reporter_id = auth.uid()), not admin-client

## SCEN-003: the view requires a session
**Given**: a visitor with no session
**When**: they navigate to `/mis-reportes`
**Then**: they do not get the view — they are redirected to sign in (`/ingresar`)
**Evidence**: agent-browser — `/mis-reportes` while anonymous redirects to `/ingresar`; the list never renders

## SCEN-004 (backend — owner capture): a report created with a session is owned
**Given**: the create path
**When**: a report is created while authenticated (a `userId` is present) vs anonymously
**Then**: the authenticated report persists `reporter_id = <that user>`; the anonymous report persists `reporter_id = null` (unchanged anonymous behavior)
**Evidence**: integration/unit — `create_report` / `createReport` with a reporter id writes that `reporter_id`; with none, `reporter_id` is null. This is the precondition that makes SCEN-001/002 possible at all

## SCEN-005 (runtime): the list renders cleanly and does not over-link
**Given**: a citizen with a visible and a non-visible own report
**When**: `/mis-reportes` loads in a real browser
**Then**: both appear with status; the non-visible one shows its status inline and does NOT link to the public detail (which 404s for non-visible reports, step12); the visible one may link to its public detail; ZERO console errors
**Evidence**: agent-browser — the rows render, the non-visible row has no public-detail link, console is clean
