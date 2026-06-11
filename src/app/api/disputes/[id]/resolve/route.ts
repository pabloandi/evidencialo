import { getSessionRole, isAdmin } from "@/lib/services/authz";
import {
  DisputeAlreadyResolvedError,
  DisputeNotFoundError,
  ForbiddenError,
  resolveDispute,
} from "@/lib/services/disputeService";
import { validateResolveInput } from "@/lib/validation/disputeSchema";

/**
 * POST /api/disputes/[id]/resolve — admin reviews a filed dispute, either
 * UPHOLDING it (the resolution stands) or REVERTING it (the report goes back to
 * `en_proceso` and the resolved-attribution is stripped). Subsystem B, chunk
 * B3.2; solver-resolution SCEN-007.
 *
 * TWO authz layers: this route's `isAdmin` 403 (a citizen/staff/anonymous caller
 * triggers no work) AND the `resolve_dispute` RPC's `private.is_admin()` guard
 * (the DB is the real boundary). This is an authenticated INTERNAL review, NOT a
 * public write — so NO anti-spam gates run here.
 *
 * Order: validate the route param (uuid -> else 400), authorize FIRST, then
 * parse + validate the body (action uphold|revert -> else 400), then call the
 * service and map its typed errors (ForbiddenError -> 403, DisputeNotFoundError
 * -> 404, DisputeAlreadyResolvedError -> 409, else 500). Node.js runtime (the
 * supabase-js client is not Edge-compatible); do NOT add
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

  // Authorize BEFORE reading the body so a non-admin caller triggers no work.
  // A session-resolution throw degrades to anonymous (role null) -> 403.
  let role: Awaited<ReturnType<typeof getSessionRole>>["role"] = null;
  try {
    ({ role } = await getSessionRole());
  } catch (error) {
    console.error("session resolution failed; treating as anonymous", { error });
  }
  if (!isAdmin(role)) {
    return Response.json(
      {
        error: {
          code: "forbidden",
          message: "No tienes permiso para revisar disputas.",
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
        error: { code: "invalid_json", message: "Cuerpo de la petición inválido." },
      },
      { status: 400 },
    );
  }

  const validation = validateResolveInput(raw);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  try {
    const res = await resolveDispute(id, validation.value.action);
    return Response.json(
      {
        dispute_status: res.dispute_status,
        report_status: res.report_status,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return Response.json(
        {
          error: {
            code: "forbidden",
            message: "No tienes permiso para revisar disputas.",
          },
        },
        { status: 403 },
      );
    }
    if (error instanceof DisputeNotFoundError) {
      return Response.json(
        { error: { code: "not_found", message: "Disputa no encontrada." } },
        { status: 404 },
      );
    }
    if (error instanceof DisputeAlreadyResolvedError) {
      return Response.json(
        {
          error: {
            code: "already_resolved",
            message: "Esta disputa ya fue revisada.",
          },
        },
        { status: 409 },
      );
    }

    console.error("POST /api/disputes/[id]/resolve failed", { id, error });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudo revisar la disputa. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}
