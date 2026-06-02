import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refresh the Supabase auth session on each request and propagate rotated
 * cookies. This is what makes a role change take effect after the user's token
 * is refreshed (AC3): the access-token hook re-runs on refresh and re-issues the
 * `user_role` claim from the current `profiles.role`.
 *
 * evidencialo allows anonymous browsing (public map, anonymous capture), so we
 * deliberately do NOT redirect unauthenticated users here. Staff-only gating is
 * enforced by the `(panel)` layout, per Next's guidance to authorize inside the
 * server component rather than relying on the proxy alone.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do NOT run code between createServerClient and getClaims(): a mistake here
  // causes hard-to-debug random logouts (Supabase SSR guidance). Guard the call
  // so a transient verification failure (e.g. JWKS fetch) degrades to "session
  // not refreshed this request" instead of 500-ing anonymous public pages.
  try {
    await supabase.auth.getClaims();
  } catch {
    // Session left unrefreshed; the request proceeds.
  }

  return supabaseResponse;
}
