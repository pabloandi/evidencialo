import { z } from "zod";

/**
 * Input validation for the staff status-change write path (step13).
 *
 * Mirrors `reportSchema.ts`: parse the untrusted body structurally with zod,
 * then return a single `{ ok, value } | { ok:false, error:{code,message} }`
 * result so the route maps the FIRST violation to one Spanish error (no array).
 *
 * Only the body shape is validated here. The report id (a route param) is a
 * UUID checked in the route, and AUTHORIZATION (staff-only) is enforced by the
 * route's `getSessionRole` 403 and, in depth, by the RPC's `private.is_staff()`
 * guard — never here.
 */

const STATUS_VALUES = ["nuevo", "en_proceso", "resuelto", "descartado"] as const;

const MAX_NOTE_CHARS = 1000;

export type ValidStatusInput = {
  status: (typeof STATUS_VALUES)[number];
  note?: string;
};

export type StatusValidationError = {
  code: string;
  message: string;
  field?: string;
};

export type StatusValidationResult =
  | { ok: true; value: ValidStatusInput }
  | { ok: false; error: StatusValidationError };

// `note` is trimmed and bounded; an empty/whitespace note collapses to omitted
// so the RPC stores NULL rather than an empty audit note.
const statusSchema = z.object({
  status: z.enum(STATUS_VALUES),
  note: z
    .string()
    .trim()
    .max(MAX_NOTE_CHARS)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

function fail(error: StatusValidationError): StatusValidationResult {
  return { ok: false, error };
}

export function validateStatusInput(raw: unknown): StatusValidationResult {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? first.path.join(".") : undefined;

    // A bad/missing `status` is the most common failure and the one the
    // scenarios pin (SCEN-005); surface it specifically, else a generic body
    // error.
    if (field === "status") {
      return fail({
        code: "status_invalid",
        message: "Estado no válido.",
        field: "status",
      });
    }
    if (field === "note") {
      // Distinguish a LENGTH violation (zod `too_big`) from a TYPE error
      // (non-string note): the code must reflect the actual problem (SCEN-H03).
      if (first?.code === "too_big") {
        return fail({
          code: "note_too_long",
          message: "La nota supera los 1000 caracteres.",
          field: "note",
        });
      }
      return fail({
        code: "note_invalid",
        message: "Nota no válida.",
        field: "note",
      });
    }
    return fail({
      code: "invalid_payload",
      message: "Cuerpo de la petición inválido.",
      field,
    });
  }

  return { ok: true, value: parsed.data };
}
