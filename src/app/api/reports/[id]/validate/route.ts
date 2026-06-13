import { verifyCaptcha } from "@/lib/captcha";
import { clientIp } from "@/lib/http/clientIp";
import { ipHash } from "@/lib/http/ipHash";
import { checkRateLimit } from "@/lib/rateLimit";
import { getSessionRole } from "@/lib/services/authz";
import {
  InvalidInputError,
  ReportNotValidatableError,
  validateReport,
} from "@/lib/services/validationService";
import { isCorroborated } from "@/lib/validation/corroboration";

/**
 * POST /api/reports/[id]/validate — corroborate that an OPEN report is real
 * ("yo también lo veo"; subsystem A, chunk A2). Additive trust: it bumps the
 * report's confirmation counts and may earn the public "Corroborado" badge — it
 * never hides a report and never gates publication.
 *
 * This is a PUBLIC write open to anyone (anon + authenticated), so it carries
 * the same two anti-spam gates as POST /api/reports (design §5.2, in ORDER):
 * rate-limit FIRST (by user id if authenticated else by client IP; fails open),
 * then captcha for ANONYMOUS callers only (a session is its own proof of
 * humanity; fails closed). The DB is the real authz boundary — the
 * `validate_report` RPC rejects a non-open/hidden report (-> P0001 ->
 * ReportNotValidatableError -> 409) and dedups re-confirmations idempotently
 * (newly_added=false -> 200).
 *
 * Identity for the RPC: authenticated -> null ip_hash (it keys on auth.uid());
 * anonymous -> the salted hash of the client IP (so per-IP dedup works without
 * storing the raw address).
 *
 * Order: validate the route param (uuid -> else 400), resolve the session
 * (throw degrades to anonymous), rate-limit, captcha-for-anon, then delegate to
 * `validateReport`. Node.js runtime (the supabase-js client + node:crypto are
 * not Edge-compatible); do NOT add `export const runtime = "edge"`.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  // Malformed id never reaches the DB (avoids a Postgres uuid-cast 500).
  if (!UUID_RE.test(id)) {
    return Response.json(
      { error: { code: "id_invalid", message: "Identificador inválido." } },
      { status: 400 },
    );
  }

  // Resolve the session BEFORE the gates so the rate-limit identifier and the
  // captcha exemption can key on it. A throw degrades to anonymous.
  let userId: string | null = null;
  try {
    ({ userId } = await getSessionRole());
  } catch (error) {
    console.error("session resolution failed; treating as anonymous", {
      error,
    });
  }

  // --- Gate 1: rate-limit (runs FIRST). ---
  const ip = clientIp(request);
  const identifier = userId ? `user:${userId}` : `ip:${ip}`;

  const { allowed } = await checkRateLimit(identifier);
  if (!allowed) {
    return Response.json(
      {
        error: {
          code: "rate_limited",
          message:
            "Has enviado demasiadas solicitudes. Espera unos minutos.",
        },
      },
      { status: 429 },
    );
  }

  // --- Gate 2: captcha (ANONYMOUS callers only; sessions are exempt). ---
  if (!userId) {
    const token = request.headers.get("cf-turnstile-response");
    const cap = await verifyCaptcha(token, ip);
    if (!cap.ok) {
      const required = cap.reason === "missing";
      return Response.json(
        {
          error: {
            code: required ? "captcha_required" : "captcha_invalid",
            message: required
              ? "Completa la verificación de seguridad."
              : "Verificación de seguridad fallida. Recarga e inténtalo de nuevo.",
          },
        },
        { status: 403 },
      );
    }
  }

  try {
    // Authenticated -> the RPC keys on auth.uid() (null ip_hash). Anonymous ->
    // the salted hash of the client IP so per-IP dedup works. Computed INSIDE the
    // try so a missing-salt throw (ipHash) maps to the route's 500 JSON contract,
    // not an unstructured framework 500.
    //
    // NOTE (accepted-by-design): when no trusted proxy header is present,
    // `clientIp` returns "unknown" and every such anon caller collides on one
    // hash -> one shared anon dedup slot per report. On Vercel the proxy always
    // sets the header so this is moot in prod; the collision is a safe
    // UNDER-count (it can never inflate anon_count), so it needs no gate.
    const ip_hash = userId ? null : ipHash(ip);

    const res = await validateReport(id, ip_hash);
    return Response.json(
      {
        verifiedCount: res.verifiedCount,
        anonCount: res.anonCount,
        corroborated: isCorroborated(res.verifiedCount),
      },
      { status: res.newlyAdded ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof ReportNotValidatableError) {
      return Response.json(
        {
          error: {
            code: "not_validatable",
            message: "Solo puedes confirmar un reporte abierto.",
          },
        },
        { status: 409 },
      );
    }
    if (error instanceof InvalidInputError) {
      return Response.json(
        {
          error: { code: "invalid_input", message: "Solicitud inválida." },
        },
        { status: 400 },
      );
    }

    console.error("POST /api/reports/[id]/validate failed", { id, error });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudo confirmar el reporte. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}
