import { verifyCaptcha } from "@/lib/captcha";
import { clientIp } from "@/lib/http/clientIp";
import { checkRateLimit } from "@/lib/rateLimit";
import { getSessionRole } from "@/lib/services/authz";
import {
  DisputeExistsError,
  ReportNotDisputableError,
  fileDispute,
} from "@/lib/services/disputeService";
import { validateDisputeInput } from "@/lib/validation/disputeSchema";

/**
 * POST /api/reports/[id]/dispute — file a public dispute against a `resuelto`
 * report's resolution (subsystem B, chunk B3.2; solver-resolution SCEN-007).
 *
 * This is a PUBLIC write open to anyone (anon + authenticated), so it carries
 * the same two anti-spam gates as POST /api/reports (design §5.2, in ORDER):
 * rate-limit FIRST (by user id if authenticated else by client IP; fails open),
 * then captcha for ANONYMOUS callers only (a session is its own proof of
 * humanity; fails closed). The DB is the real authz boundary — the
 * `report_disputes` RLS WITH CHECK rejects a dispute against a non-`resuelto`
 * report (-> ReportNotDisputableError -> 409) and the partial-unique index
 * coalesces spam (-> DisputeExistsError -> 409).
 *
 * Order: validate the route param (uuid -> else 400), resolve the session
 * (throw degrades to anonymous), rate-limit, captcha-for-anon, parse + validate
 * the body (reason optional), then delegate to `fileDispute`. Node.js runtime
 * (the supabase-js client is not Edge-compatible); do NOT add
 * `export const runtime = "edge"`.
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
  // captcha exemption can key on it. A throw degrades to anonymous (FIX 3).
  let userId: string | null = null;
  try {
    ({ userId } = await getSessionRole());
  } catch (error) {
    console.error("session resolution failed; treating as anonymous", {
      error,
    });
  }

  // --- Gate 1: rate-limit (runs FIRST, before any body parsing). ---
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

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      {
        error: { code: "invalid_json", message: "Cuerpo de la petición inválido." },
      },
      { status: 400 },
    );
  }

  const validation = validateDisputeInput(raw);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  try {
    const { id: disputeId } = await fileDispute(
      id,
      validation.value.reason ?? null,
      userId,
    );
    return Response.json({ dispute: { id: disputeId } }, { status: 201 });
  } catch (error) {
    if (error instanceof DisputeExistsError) {
      return Response.json(
        {
          error: {
            code: "dispute_exists",
            message: "Ya existe una disputa abierta para este reporte.",
          },
        },
        { status: 409 },
      );
    }
    if (error instanceof ReportNotDisputableError) {
      return Response.json(
        {
          error: {
            code: "not_disputable",
            message:
              "Solo puedes reportar como falsa la resolución de un reporte resuelto.",
          },
        },
        { status: 409 },
      );
    }

    console.error("POST /api/reports/[id]/dispute failed", { id, error });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudo registrar la disputa. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}
