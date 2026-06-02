import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for Client Components (capture flow, login UI). Runs in the
 * browser with the anon key; never the service-role key (any NEXT_PUBLIC_* var
 * is shipped to the browser). createBrowserClient is internally a singleton.
 */
export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
