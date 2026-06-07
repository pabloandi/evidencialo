---
name: auth-login
created_by: orchestrator
created_at: 2026-06-05T00:00:00Z
step: auth (prerequisite for panel step13 + mis-reportes step14)
note: Email+password auth UI via Next server actions (signInWithPassword / signUp / signOut on the @supabase/ssr server client). The backend is already wired (proxy session refresh, handle_new_user trigger → profiles role 'citizen', getSessionRole/isStaff). This adds the missing sign-in surface so staff can reach the panel and citizens can reach their reports. Server-arbitrated scenarios run as unit; the end-to-end flow is arbitrated by /agent-browser.
---

# Scenarios — login / authentication UI

Evidencialo allows anonymous browsing (public map, anonymous capture), but staff
need to sign in to reach the panel and citizens need an account to track their
reports. This is the sign-in/sign-up surface: email + password, with role-aware
redirect after login and a sign-out control.

---

## SCEN-001: a visitor can register
**Given**: a visitor on `/registro` with a valid email and a password (≥ 8 chars)
**When**: they submit the sign-up form
**Then**: an account is created (the `handle_new_user` trigger gives it a `profiles` row with role `citizen`); depending on the project's email-confirmation setting they are either signed in or shown a "revisa tu correo" confirmation message — never a raw error on a valid input
**Evidence**: unit — the signup action calls `signUp` with the validated input and branches on session-vs-confirmation; runtime — submitting valid credentials creates the auth user (visible via admin) and shows the right next step

## SCEN-002: a registered user signs in and lands by role
**Given**: a registered, confirmed user
**When**: they sign in on `/ingresar` with correct credentials
**Then**: a session is established and they are redirected by role — `staff`/`admin` → `/panel`, `citizen` → `/`
**Evidence**: unit — on `signInWithPassword` success the action resolves the role and redirects to `/panel` for staff, `/` otherwise; runtime — a staff sign-in lands on `/panel`, a citizen sign-in lands on `/`

## SCEN-003: wrong credentials are refused in-place
**Given**: a registered user
**When**: they submit a wrong password
**Then**: an inline error message is shown ("credenciales inválidas") and NO session is created (they stay on `/ingresar`)
**Evidence**: unit — `signInWithPassword` error → the action returns an error state, does not redirect; runtime — the page shows the error and the user is still anonymous

## SCEN-004: invalid input is validated before hitting Supabase
**Given**: a malformed email or a password shorter than the minimum
**When**: the form is submitted
**Then**: a validation error is shown and the Supabase auth call is NOT made
**Evidence**: unit — `validateAuthInput` rejects (bad email / short password) and the action returns the validation error without calling the client

## SCEN-005: signing out clears the session
**Given**: a signed-in user
**When**: they activate "Salir" (sign out)
**Then**: the session is cleared; returning to a protected route (`/panel`) redirects them away again (the step13 gate re-applies)
**Evidence**: runtime — after sign-out, `/panel` redirects to `/` (or `/ingresar`); the session cookie is gone

## SCEN-006: with a real staff session the panel is reachable (gate inverse)
**Given**: a `staff` user who signed in through the UI (no cookie injection)
**When**: they navigate to `/panel`
**Then**: the panel renders (the layout gate passes) and they can change a report's status — closing the loop with step13 SCEN-009/010 via the real login path
**Evidence**: agent-browser — after a staff UI sign-in, `/panel` shows the list and a status change succeeds

## SCEN-007 (runtime): the auth flow works end to end with zero console errors
**Given**: the local stack
**When**: a user registers (or a seeded confirmed user), signs in, is redirected by role, and signs out
**Then**: each step works in a real browser with ZERO console errors and no failed requests (favicon aside)
**Evidence**: agent-browser — the register→sign-in→redirect→sign-out path completes; console + network panels are clean
