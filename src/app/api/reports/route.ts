import { verifyCaptcha } from "@/lib/captcha";
import { parseBbox } from "@/lib/geo";
import { checkRateLimit } from "@/lib/rateLimit";
import { getSessionRole } from "@/lib/services/authz";
import {
  CategoryInvalidError,
  createReport,
  listInBbox,
} from "@/lib/services/reportService";
import { validateReportInput } from "@/lib/validation/reportSchema";

/**
 * POST /api/reports — create a report (step05) behind two anti-spam gates
 * (step06).
 *
 * Runs on the Node.js runtime (the default for Route Handlers): the write path
 * uses the service-role supabase-js client, which is not Edge-compatible. Do
 * NOT add `export const runtime = "edge"`.
 *
 * Gates (design §5.2, in ORDER): rate-limit FIRST (by user id if authenticated
 * else by client IP; fails open), then captcha for ANONYMOUS callers only (a
 * session is its own proof of humanity; fails closed). Then the step05 flow:
 * read the optional `Idempotency-Key` header, parse + validate the body (first
 * violation -> 422 with the scenario's Spanish message), then delegate to
 * `createReport`. A fresh report returns 201; an idempotent replay returns 200.
 */

/** Max accepted length of an Idempotency-Key (defensive bound). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Resolve the client IP for rate-limiting (FIX 2).
 *
 * `x-vercel-forwarded-for` / `x-real-ip` are set by the Vercel proxy and are
 * NOT forwarded from the client, so they are trustworthy. The FIRST hop of
 * `x-forwarded-for` IS client-controlled (an attacker can rotate it to dodge a
 * per-IP limit); the proxy appends the real peer as the TRAILING hop, so we key
 * on that. Falls back to `"unknown"` when no header is present.
 */
function clientIp(request: Request): string {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim();

  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();

  const xff = request.headers.get("x-forwarded-for");
  return xff?.split(",").pop()?.trim() || "unknown";
}

export async function POST(request: Request): Promise<Response> {
  // --- Gate 1: rate-limit (runs FIRST, before any body parsing). ---
  // Session resolution may throw before any gate (e.g. supabase client
  // construction); degrade to anonymous (captcha-walled), never 500 (FIX 3).
  let userId: string | null = null;
  try {
    ({ userId } = await getSessionRole());
  } catch (error) {
    console.error("session resolution failed; treating as anonymous", {
      error,
    });
  }
  const ip = clientIp(request);
  const identifier = userId ? `user:${userId}` : `ip:${ip}`;

  const { allowed } = await checkRateLimit(identifier);
  if (!allowed) {
    return Response.json(
      {
        error: {
          code: "rate_limited",
          message: "Has enviado demasiados reportes. Espera unos minutos.",
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

  // A blank or whitespace-only header is "no key": coerce to undefined so it is
  // persisted as NULL (the partial unique index allows many NULLs) and never
  // collides across unrelated requests (SCEN-010).
  const rawKey = request.headers.get("Idempotency-Key")?.trim();
  const idempotencyKey = rawKey ? rawKey : undefined;

  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return Response.json(
      {
        error: {
          code: "idempotency_key_invalid",
          message: "La clave de idempotencia es demasiado larga.",
        },
      },
      { status: 422 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_json",
          message: "Cuerpo de la petición inválido.",
        },
      },
      { status: 422 },
    );
  }

  const validation = validateReportInput(raw);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 422 });
  }

  try {
    // Forward the resolved session user (null for anonymous) so the report is
    // associated with its author — the precondition for `/mis-reportes` (step14).
    const result = await createReport(validation.value, idempotencyKey, userId);
    return Response.json(
      {
        report_id: result.report.id,
        media: result.media.map((m) => ({
          id: m.id,
          type: m.type,
          upload: { signedUrl: m.signedUrl, token: m.token, path: m.path },
        })),
      },
      { status: result.idempotent ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof CategoryInvalidError) {
      return Response.json(
        {
          error: {
            code: "category_invalid",
            message: "Categoría no válida.",
            field: "category",
          },
        },
        { status: 422 },
      );
    }

    console.error("POST /api/reports failed", {
      idempotencyKey,
      error,
    });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudo crear el reporte. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/reports?bbox=minLng,minLat,maxLng,maxLat — the public map read
 * (step11, public-map-bbox.scenarios.md).
 *
 * A PUBLIC, cacheable read with NO auth and NO anti-spam gates — those belong to
 * the write path (POST) only and must never run here. The untrusted `bbox` is
 * validated by `parseBbox` BEFORE any DB call: a malformed or over-large box is
 * a structured 400 with no scan (SCEN-003). A valid box delegates to
 * `listInBbox`, whose SECURITY DEFINER RPC returns ONLY visible reports with
 * PUBLIC fields — `reporter_id` and the precise `address` are never exposed
 * (SCEN-004). A dense viewport is truncated to the newest rows; when that
 * happens the response carries `X-Result-Truncated: true` so the loss is
 * signaled rather than silent (SCEN-H03) — the body stays the bare marker
 * array. Runs on the Node.js runtime (the supabase-js client is not
 * Edge-compatible); do NOT add `export const runtime = "edge"`.
 */
export async function GET(request: Request): Promise<Response> {
  const bbox = parseBbox(new URL(request.url).searchParams.get("bbox"));
  if (!bbox.ok) {
    return Response.json({ error: bbox.error }, { status: 400 });
  }

  try {
    const { markers, truncated } = await listInBbox(bbox.value);
    return Response.json(markers, {
      status: 200,
      headers: truncated ? { "X-Result-Truncated": "true" } : undefined,
    });
  } catch (error) {
    console.error("GET /api/reports failed", { error });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudieron cargar los reportes. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}
