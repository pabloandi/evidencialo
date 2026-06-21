import { sanitizeQrImage, InvalidQrImageError } from "@/lib/donation/qrImage";
import { checkRateLimit } from "@/lib/rateLimit";
import { getSessionRole, isSolver } from "@/lib/services/authz";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { DONATION_TYPES } from "@/lib/validation/donationSchema";

/**
 * POST /api/solver/donation-qr — a verified solver uploads the QR image their
 * banking app exported for a Colombian rail (subsystem D, chunk D2; SCEN-007).
 *
 * OWNER-ONLY: the caller must have a session AND the `solver` role
 * (`getSessionRole()` + `isSolver`); anon → 401, non-solver → 403. This gate is
 * IDENTICAL to the donation-channels route (the two must not drift). A light
 * per-user rate-limit bounds storage abuse. There is NO captcha (writes are
 * authenticated, not anonymous).
 *
 * Body is multipart: a `file` (the QR image) + a `type` field ∈ the donation
 * allowlist (only the three uploaded rails — paypal auto-generates, never
 * uploads). The handler sanitizes the image to lossless PNG (metadata stripped,
 * ≤1024 cap, validated as a real image), uploads it to
 * `donation-qr/<userId>/<type>.png` via the SERVICE-ROLE admin client (the
 * bucket has no client write policy), and returns `{ qrPath }`. The save route
 * then persists `qrPath` onto the channel.
 *
 * Node.js runtime (sharp's native binary + the supabase-js client are not
 * Edge-compatible). Do NOT add `export const runtime = "edge"`.
 */

const BUCKET = "donation-qr";

// Hard cap the upload BEFORE buffering it into memory — `sharp`'s MAX_PIXELS
// guard only fires after the bytes are already allocated, and the platform body
// limit must not be the only backstop. 8 MB is generous for a phone QR export.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// PayPal never uploads a QR (it is auto-generated) — only the three Colombian
// rails accept an uploaded image.
const UPLOADABLE_TYPES = DONATION_TYPES.filter((t) => t !== "paypal");

function jsonError(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  // --- Owner gate (resolve session first; a throw degrades to anonymous). ---
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
      "Solo los solucionadores pueden subir códigos QR.",
      403,
    );
  }

  // --- Rate-limit (per user) to bound storage abuse. ---
  const { allowed } = await checkRateLimit(`user:${userId}`);
  if (!allowed) {
    return jsonError(
      "rate_limited",
      "Has enviado demasiadas solicitudes. Espera unos minutos.",
      429,
    );
  }

  // --- Parse multipart: file + type. ---
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("invalid_payload", "Cuerpo de la petición inválido.", 400);
  }

  const type = form.get("type");
  if (
    typeof type !== "string" ||
    !(UPLOADABLE_TYPES as readonly string[]).includes(type)
  ) {
    return jsonError("type_invalid", "Tipo de canal no válido.", 422);
  }

  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return jsonError("file_missing", "Falta la imagen del código QR.", 422);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(
      "file_too_large",
      "La imagen es demasiado grande (máximo 8 MB).",
      413,
    );
  }

  // --- Sanitize the image (lossless PNG, metadata stripped, ≤1024 cap). ---
  let sanitized: Awaited<ReturnType<typeof sanitizeQrImage>>;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    sanitized = await sanitizeQrImage(buf);
  } catch (error) {
    if (error instanceof InvalidQrImageError) {
      return jsonError(
        "qr_invalid",
        "La imagen no es válida. Sube una imagen del código QR.",
        422,
      );
    }
    console.error("POST /api/solver/donation-qr sanitize failed", { error });
    return jsonError(
      "internal_error",
      "No se pudo procesar la imagen. Inténtalo de nuevo.",
      500,
    );
  }

  // --- Upload via the SERVICE-ROLE admin client (bucket has no client write
  //     policy). The path is keyed to the OWNER's userId (never a client field).
  const qrPath = `${userId}/${type}.png`;
  try {
    const admin = createAdminSupabase();
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(qrPath, sanitized.data, {
        upsert: true,
        contentType: "image/png",
      });
    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    console.error("POST /api/solver/donation-qr upload failed", { error });
    return jsonError(
      "upload_failed",
      "No se pudo guardar la imagen. Inténtalo de nuevo.",
      503,
    );
  }

  return Response.json({ qrPath: `${BUCKET}/${qrPath}` }, { status: 200 });
}
