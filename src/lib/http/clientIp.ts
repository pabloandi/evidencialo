/**
 * Resolve the client IP for rate-limiting (FIX 2).
 *
 * `x-vercel-forwarded-for` / `x-real-ip` are set by the Vercel proxy and are
 * NOT forwarded from the client, so they are trustworthy. The FIRST hop of
 * `x-forwarded-for` IS client-controlled (an attacker can rotate it to dodge a
 * per-IP limit); the proxy appends the real peer as the TRAILING hop, so we key
 * on that. Falls back to `"unknown"` when no header is present.
 */
export function clientIp(request: Request): string {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim();

  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();

  const xff = request.headers.get("x-forwarded-for");
  return xff?.split(",").pop()?.trim() || "unknown";
}
