import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * No-op WebSocket transport for the Realtime client.
 *
 * supabase-js builds a RealtimeClient eagerly inside `createClient`, and on
 * Node < 22 (e.g. Vercel's Node 20 runtime) that constructor throws because no
 * native `WebSocket` global exists. The write path never opens a Realtime
 * channel, so we hand it an inert constructor: it satisfies the eager lookup
 * without pulling in the `ws` dependency and is never actually instantiated for
 * a connection. If anything ever did try to connect, it would fail loudly.
 */
class NoopWebSocket {
  constructor() {
    throw new Error(
      "Realtime is not supported on the service-role admin client.",
    );
  }
}

/**
 * Service-role Supabase client for the SERVER-SIDE write path only.
 *
 * WARNING: this client uses the service-role key and BYPASSES Row Level
 * Security entirely. It must NEVER be imported into client components, the
 * browser bundle, or any code reachable by an untrusted caller. Use it only
 * inside server route handlers / services that have already validated input.
 *
 * Sessions are disabled (`persistSession: false`, `autoRefreshToken: false`):
 * each request builds a fresh stateless admin client.
 */
export function createAdminSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      "createAdminSupabase: NEXT_PUBLIC_SUPABASE_URL is not set.",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "createAdminSupabase: SUPABASE_SERVICE_ROLE_KEY is not set.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Cast: the Realtime transport type is internal; NoopWebSocket only needs
    // to be a `new (...) => unknown` to satisfy the eager constructor lookup.
    realtime: { transport: NoopWebSocket as never },
  });
}
