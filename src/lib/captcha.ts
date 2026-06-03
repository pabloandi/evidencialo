/**
 * Cloudflare Turnstile captcha gate for POST /api/reports (step06, design §5.2 —
 * runs AFTER rate-limit, only for ANONYMOUS callers; a session is its own proof
 * of humanity). The client sends its token in the `cf-turnstile-response` header.
 *
 * FAILS CLOSED: this IS the anti-spam wall for anonymous writes, so a siteverify
 * network error/timeout DENIES (returns reason "error") rather than letting the
 * request through (SCEN-007).
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type CaptchaResult = {
  ok: boolean;
  reason?: "missing" | "invalid" | "error";
};

/** Cloudflare siteverify response (only the fields we read). */
type SiteverifyResponse = {
  success: boolean;
  "error-codes"?: string[];
};

/**
 * A valid Turnstile token is ~hundreds of chars; anything past this is junk we
 * refuse before spending a siteverify round trip (FIX 4 — DoS / abuse guard).
 */
const MAX_TOKEN_LENGTH = 2048;

export async function verifyCaptcha(
  token: string | null | undefined,
  remoteip?: string,
): Promise<CaptchaResult> {
  // Normalize once: trim and treat empty/whitespace as no token (SCEN-002).
  const t = typeof token === "string" ? token.trim() : "";
  if (!t) {
    return { ok: false, reason: "missing" };
  }

  // Oversized token: reject as invalid WITHOUT calling siteverify (FIX 4).
  if (t.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "invalid" };
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Misconfiguration, not a client error: surface loudly so it is fixed.
    throw new Error(
      "TURNSTILE_SECRET_KEY is not set; cannot verify captcha tokens.",
    );
  }

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: t,
        ...(remoteip ? { remoteip } : {}),
      }),
    });

    const data = (await response.json()) as SiteverifyResponse;
    if (data.success) {
      return { ok: true };
    }
    // Surface the error-codes for observability; the returned reason is unchanged.
    console.warn("turnstile siteverify rejected", {
      errorCodes: data["error-codes"],
    });
    return { ok: false, reason: "invalid" };
  } catch (error) {
    // Fail closed: a network/timeout error denies the anonymous write (SCEN-007).
    console.error("Turnstile siteverify call failed", { error });
    return { ok: false, reason: "error" };
  }
}
