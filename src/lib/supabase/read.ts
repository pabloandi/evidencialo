import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Stateless ANON read client for PUBLIC, cacheable server-side reads (step11).
 *
 * The public map's bbox read has no session and no cookies: it is the same for
 * every caller, so it must NOT bind to request cookies (that would force the
 * route to opt out of caching). This client uses the anon key with sessions
 * disabled, so it carries no user context — exactly what a public read wants.
 * RLS still applies, but the read goes through the SECURITY DEFINER
 * `reports_in_view` RPC, which returns only visible + public-field rows.
 *
 * Reuses the same inert-Realtime guard as the admin client: supabase-js builds
 * a RealtimeClient eagerly, which throws on Node < 22 without a `WebSocket`
 * global. The read path never opens a channel.
 */
class NoopWebSocket {
  constructor() {
    throw new Error("Realtime is not supported on the anon read client.");
  }
}

export function createReadSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error("createReadSupabase: NEXT_PUBLIC_SUPABASE_URL is not set.");
  }
  if (!anonKey) {
    throw new Error(
      "createReadSupabase: NEXT_PUBLIC_SUPABASE_ANON_KEY is not set.",
    );
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: NoopWebSocket as never },
  });
}
