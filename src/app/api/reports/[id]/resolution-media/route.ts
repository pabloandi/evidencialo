import { getSessionRole, isSolver, isStaff } from "@/lib/services/authz";
import {
  ForbiddenError,
  ReportNotFoundError,
  attachResolutionMedia,
} from "@/lib/services/resolutionService";
import { validateMediaInput } from "@/lib/validation/reportSchema";

/**
 * POST /api/reports/[id]/resolution-media — attach RESOLUTION PROOF media to an
 * existing report (chunk B2.2a, solver-resolution.scenarios.md SCEN-002).
 *
 * The universal proof gate (0015) refuses to resolve a report without >=1
 * processed kind='resolution' media. This route is the write path that supplies
 * that proof: it mints signed upload URLs for proof objects (mirroring the media
 * contract of POST /api/reports), and the client uploads + triggers processing
 * exactly as for complaint media.
 *
 * TWO authz layers (like the status route): this route's `getSessionRole` gate
 * (a citizen/anonymous caller never triggers any work) AND the RPC's
 * `private.is_staff()` / `private.is_solver()` guard (the DB is the real
 * boundary). The gate is `staff OR solver` — NOT solver-only — because the proof
 * gate is UNIVERSAL: staff/admin retain resolve powers, so they must be able to
 * supply proof too. A solver session passes; a citizen/anon does not.
 *
 * Order: validate the route param (uuid -> else 400) and authorize FIRST, then
 * parse + validate the `{ media: [...] }` body (same mime/type/count limits as
 * report creation -> invalid 422), then call the service and map its typed
 * errors (ForbiddenError -> 403, ReportNotFoundError -> 404, else 500). A fresh
 * attach returns 201 with the upload contract. Node.js runtime (the supabase-js
 * client is not Edge-compatible); do NOT add `export const runtime = "edge"`.
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

  // Authorize BEFORE reading the body so a non-staff/non-solver caller triggers
  // no work. A session-resolution throw degrades to anonymous (role null) -> 403.
  let role: Awaited<ReturnType<typeof getSessionRole>>["role"] = null;
  try {
    ({ role } = await getSessionRole());
  } catch (error) {
    console.error("session resolution failed; treating as anonymous", { error });
  }
  if (!(isStaff(role) || isSolver(role))) {
    return Response.json(
      {
        error: {
          code: "forbidden",
          message: "No tienes permiso para adjuntar evidencia de resolución.",
        },
      },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      {
        error: { code: "invalid_payload", message: "Cuerpo de la petición inválido." },
      },
      { status: 422 },
    );
  }

  // The proof payload is `{ media: [...] }`; validate the array with the SAME
  // limits as report creation. A non-object body yields `raw.media = undefined`
  // -> structural failure -> 422.
  const media = (raw as { media?: unknown } | null)?.media;
  const validation = validateMediaInput(media);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 422 });
  }

  try {
    const result = await attachResolutionMedia(id, validation.value);
    return Response.json(
      {
        media: result.media.map((m) => ({
          id: m.id,
          type: m.type,
          upload: { signedUrl: m.signedUrl, token: m.token, path: m.path },
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return Response.json(
        {
          error: {
            code: "forbidden",
            message: "No tienes permiso para adjuntar evidencia de resolución.",
          },
        },
        { status: 403 },
      );
    }
    if (error instanceof ReportNotFoundError) {
      return Response.json(
        { error: { code: "not_found", message: "Reporte no encontrado." } },
        { status: 404 },
      );
    }

    console.error("POST /api/reports/[id]/resolution-media failed", { id, error });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudo adjuntar la evidencia. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}
