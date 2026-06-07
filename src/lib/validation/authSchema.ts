import { z } from "zod";

/**
 * Input validation for the email+password auth surface (login / sign-up).
 *
 * Mirrors `statusSchema.ts`: parse the untrusted form input structurally with
 * zod, then return a single `{ ok, value } | { ok:false, error:{code,message} }`
 * result so the server action maps the FIRST violation to one Spanish error.
 *
 * Only the input SHAPE is validated here — never authentication itself: whether
 * the credentials are correct is Supabase's job (`signInWithPassword`). This
 * gate just stops malformed input (bad email, short password) before it reaches
 * the auth client (SCEN-004).
 */

const MIN_PASSWORD_CHARS = 8;

export type ValidAuthInput = {
  email: string;
  password: string;
};

export type AuthValidationError = {
  code: string;
  message: string;
  field?: string;
};

export type AuthValidationResult =
  | { ok: true; value: ValidAuthInput }
  | { ok: false; error: AuthValidationError };

const authSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(MIN_PASSWORD_CHARS),
});

function fail(error: AuthValidationError): AuthValidationResult {
  return { ok: false, error };
}

export function validateAuthInput(raw: unknown): AuthValidationResult {
  const parsed = authSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? first.path.join(".") : undefined;

    if (field === "email") {
      return fail({
        code: "email_invalid",
        message: "Ingresa un correo válido.",
        field: "email",
      });
    }
    if (field === "password") {
      return fail({
        code: "password_too_short",
        message: "La contraseña debe tener al menos 8 caracteres.",
        field: "password",
      });
    }
    // Non-object input (string, null, missing fields) — a generic shape error.
    return fail({
      code: "invalid_input",
      message: "Datos de acceso inválidos.",
      field,
    });
  }

  return { ok: true, value: parsed.data };
}
