import {
  CategoryInvalidError,
  createReport,
} from "@/lib/services/reportService";
import { validateReportInput } from "@/lib/validation/reportSchema";

/**
 * POST /api/reports — create a report (step05).
 *
 * Runs on the Node.js runtime (the default for Route Handlers): the write path
 * uses the service-role supabase-js client, which is not Edge-compatible. Do
 * NOT add `export const runtime = "edge"`.
 *
 * Flow: read the optional `Idempotency-Key` header, parse + validate the body
 * (first violation -> 422 with the scenario's Spanish message), then delegate
 * to `createReport`. A fresh report returns 201; an idempotent replay returns
 * 200 with the same `report_id`.
 */

/** Max accepted length of an Idempotency-Key (defensive bound). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export async function POST(request: Request): Promise<Response> {
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
    const result = await createReport(validation.value, idempotencyKey);
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
