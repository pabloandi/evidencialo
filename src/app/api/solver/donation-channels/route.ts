import { clientIp } from "@/lib/http/clientIp";
import { getSessionRole, isSolver } from "@/lib/services/authz";
import {
  ForbiddenError,
  InvalidChannelError,
  deleteDonationChannel,
  setDonationChannel,
} from "@/lib/services/donationService";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  DONATION_TYPES,
  validateDonationChannel,
  type DonationType,
} from "@/lib/validation/donationSchema";

/**
 * POST / DELETE /api/solver/donation-channels — a verified solver saves or
 * removes one of their own donation channels (subsystem D, chunk D2).
 *
 * OWNER-ONLY: the caller must have a session AND the `solver` role
 * (`getSessionRole()` + `isSolver`), IDENTICAL to the donation-qr route (the two
 * gates must not drift); anon → 401, non-solver → 403.
 *
 * The write goes through the AUTHENTICATED server client so the DEFINER RPC's
 * `auth.uid()` resolves to the caller — `solver_id` is derived solely inside the
 * RPC and is NEVER forwarded from the client. A request body carrying a stray
 * `solver_id` / `solverId` is therefore inert: this handler never reads it (the
 * SCEN-002 boundary at the HTTP layer). The request IP + user-agent are threaded
 * into `p_request_meta` so the audit history records them.
 *
 * POST body: `{ type, value, accountKind?, qrPath? }` — validated + normalized
 * by `donationSchema` (a non-`paypal.me` PayPal value → 422, proving the schema
 * is on the write path). DELETE body: `{ type }`.
 *
 * Node.js runtime (the supabase-js client is not Edge-compatible). Do NOT add
 * `export const runtime = "edge"`.
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** Resolve + gate the owner. Returns the userId, or a Response to short-circuit. */
async function gateOwner(): Promise<{ userId: string } | Response> {
  let userId: string | null = null;
  let role: Awaited<ReturnType<typeof getSessionRole>>["role"] = null;
  try {
    ({ userId, role } = await getSessionRole());
  } catch (error) {
    console.error("session resolution failed; treating as anonymous", { error });
  }

  if (!userId) {
    return jsonError("unauthorized", "Debes iniciar sesión.", 401);
  }
  if (!isSolver(role)) {
    return jsonError(
      "forbidden",
      "Solo los solucionadores pueden gestionar canales de donación.",
      403,
    );
  }
  return { userId };
}

function requestMeta(request: Request) {
  return { ip: clientIp(request), ua: request.headers.get("user-agent") };
}

function mapServiceError(error: unknown, op: string): Response {
  if (error instanceof ForbiddenError) {
    return jsonError(
      "forbidden",
      "No tienes permiso para gestionar este canal.",
      403,
    );
  }
  if (error instanceof InvalidChannelError) {
    return jsonError(
      "channel_invalid",
      "El canal de donación no es válido.",
      422,
    );
  }
  console.error(`${op} failed`, { error });
  return jsonError(
    "internal_error",
    "No se pudo procesar la solicitud. Inténtalo de nuevo.",
    500,
  );
}

export async function POST(request: Request): Promise<Response> {
  const gate = await gateOwner();
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("invalid_json", "Cuerpo de la petición inválido.", 400);
  }

  // SCEN-006 wired: the schema validates + normalizes on the write path. A
  // qrPath, if present, is read separately — it is NOT part of the validated
  // channel shape (it comes from the donation-qr route).
  const validation = validateDonationChannel(raw);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 422 });
  }

  const qrPath =
    raw && typeof raw === "object" && "qrPath" in raw
      ? (raw as { qrPath?: unknown }).qrPath
      : null;
  const safeQrPath = typeof qrPath === "string" && qrPath.length > 0 ? qrPath : null;

  // qr_path is a public, money-redirect-adjacent pointer (rendered on the public
  // profile in D3). The ONLY legitimate value is the object the donation-qr upload
  // route produced for THIS caller + THIS rail: `donation-qr/<userId>/<type>.png`.
  // Reject anything else so a solver cannot point their channel at another solver's
  // object (or an arbitrary bucket path). PayPal auto-generates its QR → never one.
  if (safeQrPath !== null) {
    const expectedQrPath = `donation-qr/${gate.userId}/${validation.value.type}.png`;
    if (validation.value.type === "paypal" || safeQrPath !== expectedQrPath) {
      return jsonError(
        "qr_path_invalid",
        "La ruta del código QR no es válida.",
        422,
      );
    }
  }

  try {
    // AUTHENTICATED server client → auth.uid() = the caller inside the RPC.
    // solver_id is derived there, never forwarded from the request body.
    const db = await createServerSupabase();
    const row = await setDonationChannel(
      db,
      {
        type: validation.value.type,
        value: validation.value.value,
        accountKind: validation.value.accountKind,
        qrPath: safeQrPath,
      },
      requestMeta(request),
    );
    return Response.json(
      {
        channel: {
          type: row.type,
          value: row.value,
          account_kind: row.account_kind,
          qr_path: row.qr_path,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return mapServiceError(error, "POST /api/solver/donation-channels");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = await gateOwner();
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("invalid_json", "Cuerpo de la petición inválido.", 400);
  }

  const type =
    raw && typeof raw === "object" && "type" in raw
      ? (raw as { type?: unknown }).type
      : undefined;
  if (
    typeof type !== "string" ||
    !(DONATION_TYPES as readonly string[]).includes(type)
  ) {
    return jsonError("type_invalid", "Tipo de canal no válido.", 422);
  }

  try {
    const db = await createServerSupabase();
    await deleteDonationChannel(db, type as DonationType, requestMeta(request));
    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    return mapServiceError(error, "DELETE /api/solver/donation-channels");
  }
}
