import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client bound to the request's cookies, for Server Components, Route
 * Handlers and the proxy. Uses the anon key + the user's session (RLS applies).
 * `cookies()` is async in Next 16, so this factory is async too.
 *
 * The write path (service-role client) is introduced in step05; this client
 * never sees the service-role key.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll was called from a Server Component, where cookies are
            // read-only. Safe to ignore: the proxy refreshes the session.
          }
        },
      },
    },
  );
}
