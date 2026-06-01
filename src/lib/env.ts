/**
 * Fail-fast environment validation.
 *
 * Deployment-first: misconfiguration should surface at boot, not mid-request.
 * Later steps validate their own required keys (Supabase, MapTiler, Turnstile,
 * Upstash) through this helper.
 */

export class MissingEnvError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing required environment variables: ${missing.join(", ")}`);
    this.name = "MissingEnvError";
  }
}

/**
 * Returns the requested keys from `source`, or throws `MissingEnvError` listing
 * every key that is absent or empty. An empty string counts as missing.
 */
export function requireEnv<K extends string>(
  source: Record<string, string | undefined>,
  keys: readonly K[],
): Record<K, string> {
  const missing = keys.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }
  return Object.fromEntries(
    keys.map((key) => [key, source[key] as string]),
  ) as Record<K, string>;
}
