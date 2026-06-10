import { getSessionRole, isSolver, isStaff } from "@/lib/services/authz";
import {
  ForbiddenError,
  ProofRequiredError,
  ReportNotFoundError,
  changeReportStatus,
} from "@/lib/services/statusService";
import { validateStatusInput } from "@/lib/validation/statusSchema";

/**
 * POST /api/reports/[id]/status — the staff AUDITED status-change write
 * (step13, panel-status-change.scenarios.md).
 *
 * TWO authz layers: this route's `getSessionRole` 403 (a citizen/anonymous
 * caller never triggers any work — SCEN-001/002) AND the RPC's
 * `private.is_staff()` / `private.is_solver()` guard (the DB is the real
 * boundary — SCEN-007, solver SCEN-004). Staff AND verified solvers pass the
 * route gate; the RPC independently re-checks the role and restricts a solver to
 * en_proceso/resuelto. No anti-spam gates: this is an authenticated INTERNAL
 * write, not the public POST.
 *
 * Order: validate the route param (uuid -> else 400) and authorize FIRST, then
 * parse + validate the body (invalid status -> 400, SCEN-005), then call the
 * service and map its typed errors (ForbiddenError -> 403, ReportNotFoundError
 * -> 404, ProofRequiredError -> 422 (solver SCEN-003), else 500). Node.js
 * runtime (the supabase-js client is not Edge-compatible); do NOT add
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

  // Authorize BEFORE reading the body so a non-staff caller triggers no work.
  // A session-resolution throw degrades to anonymous (role null) -> 403.
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
          message: "No tienes permiso para cambiar el estado de un reporte.",
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
      { error: { code: "invalid_json", message: "Cuerpo de la petición inválido." } },
      { status: 400 },
    );
  }

  const validation = validateStatusInput(raw);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  try {
    const res = await changeReportStatus(
      id,
      validation.value.status,
      validation.value.note ?? null,
    );
    return Response.json(res, { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return Response.json(
        {
          error: {
            code: "forbidden",
            message: "No tienes permiso para cambiar el estado de un reporte.",
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
    if (error instanceof ProofRequiredError) {
      return Response.json(
        {
          error: {
            code: "proof_required",
            message:
              "Debes adjuntar evidencia (foto/video) procesada antes de marcar el reporte como resuelto.",
          },
        },
        { status: 422 },
      );
    }

    console.error("POST /api/reports/[id]/status failed", { id, error });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudo cambiar el estado. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}
