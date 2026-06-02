import { createServerSupabase } from "@/lib/supabase/server";

// Authorization for evidencialo's three surfaces. The role lives in
// `profiles.role` and is exposed as the JWT `user_role` claim by the
// `custom_access_token_hook` (migration 0005). Reading it from the claim avoids
// a per-request DB round trip; when the hook is not yet enabled on a project we
// fall back to a live `profiles` read so the panel still gates correctly.

export type AppRole = "citizen" | "staff" | "admin";

const KNOWN_ROLES: ReadonlySet<string> = new Set<AppRole>([
  "citizen",
  "staff",
  "admin",
]);

/** Narrow an untrusted value to a known role, or null if unrecognized. */
export function normalizeRole(value: unknown): AppRole | null {
  return typeof value === "string" && KNOWN_ROLES.has(value)
    ? (value as AppRole)
    : null;
}

/**
 * Resolve the app role from a decoded JWT claims object.
 * - valid `user_role` claim → that role
 * - claims present but role missing/invalid → `citizen` (the default role every
 *   authenticated user gets via `handle_new_user`)
 * - no claims at all → `null` (anonymous visitor)
 */
export function roleFromClaims(
  claims: Record<string, unknown> | null | undefined,
): AppRole | null {
  if (!claims) return null;
  return normalizeRole(claims["user_role"]) ?? "citizen";
}

/** Staff-level role (municipal staff or admin). */
export function isStaff(role: AppRole | null): boolean {
  return role === "staff" || role === "admin";
}

/** Whether a role may access the management panel `(panel)`. */
export function canAccessPanel(role: AppRole | null): boolean {
  return isStaff(role);
}

export type SessionRole = {
  userId: string | null;
  role: AppRole | null;
};

/**
 * Resolve the current request's user id and role from the Supabase session.
 * Uses `getClaims()` (validates the JWT — locally when the project signs tokens
 * with asymmetric keys) and prefers the `user_role` claim; falls back to a
 * `profiles` read only when the claim is absent (hook not yet enabled).
 *
 * Fails CLOSED: any uncertainty (auth error, verification throw, DB error)
 * resolves to no role, so the panel gate denies rather than leaking access.
 */
export async function getSessionRole(): Promise<SessionRole> {
  const supabase = await createServerSupabase();

  let claims: Record<string, unknown> | undefined;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error) {
      // Expired / invalid / tampered token: treat as anonymous.
      return { userId: null, role: null };
    }
    claims = data?.claims as Record<string, unknown> | undefined;
  } catch {
    // Transient verification failure (e.g. JWKS fetch). Deny, don't crash.
    return { userId: null, role: null };
  }

  const sub = claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) {
    return { userId: null, role: null };
  }

  // Hook enabled: the `user_role` key is present (its value may be a role or
  // null for a roleless user). Trust it and skip the DB round trip.
  if (claims && "user_role" in claims) {
    return { userId: sub, role: roleFromClaims(claims) };
  }

  // Hook not enabled on this project yet: read the live role. RLS policy
  // `profiles_select_own` authorizes the user to read their own row.
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", sub)
    .maybeSingle();

  if (error) {
    // DB/RLS failure — deny rather than silently coercing a role.
    return { userId: sub, role: null };
  }

  return { userId: sub, role: normalizeRole(profile?.role) ?? "citizen" };
}
