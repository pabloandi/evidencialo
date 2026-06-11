import { z } from "zod";

/**
 * Input validation for the dispute write paths (subsystem B, chunk B3.2).
 *
 * Mirrors `statusSchema.ts`: parse the untrusted body structurally with zod,
 * then return a single `{ ok, value } | { ok:false, error:{code,message} }`
 * result so the route maps the FIRST violation to one Spanish error (no array).
 *
 * Only the body shape is validated here. The report/dispute id (a route param)
 * is a UUID checked in the route, and AUTHORIZATION is enforced by the route's
 * gates and, in depth, by the DB layer (the `report_disputes` RLS WITH CHECK for
 * filing, the `resolve_dispute` RPC's `private.is_admin()` guard for review) —
 * never here.
 */

const MAX_REASON_CHARS = 1000;

const RESOLVE_ACTIONS = ["uphold", "revert"] as const;

export type ValidDisputeInput = {
  reason?: string;
};

export type ValidResolveInput = {
  action: (typeof RESOLVE_ACTIONS)[number];
};

export type DisputeValidationError = {
  code: string;
  message: string;
  field?: string;
};

export type DisputeValidationResult =
  | { ok: true; value: ValidDisputeInput }
  | { ok: false; error: DisputeValidationError };

export type ResolveValidationResult =
  | { ok: true; value: ValidResolveInput }
  | { ok: false; error: DisputeValidationError };

// `reason` is trimmed and bounded; an empty/whitespace reason collapses to
// omitted so the dispute stores NULL rather than an empty motive.
const disputeSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(MAX_REASON_CHARS)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

const resolveSchema = z.object({
  action: z.enum(RESOLVE_ACTIONS),
});

function failDispute(error: DisputeValidationError): DisputeValidationResult {
  return { ok: false, error };
}

export function validateDisputeInput(raw: unknown): DisputeValidationResult {
  const parsed = disputeSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? first.path.join(".") : undefined;

    // A reason past the bound (zod `too_big`) is the only field-specific
    // failure we surface; everything else is a generic body error.
    if (field === "reason" && first?.code === "too_big") {
      return failDispute({
        code: "reason_too_long",
        message: "El motivo supera los 1000 caracteres.",
        field: "reason",
      });
    }
    return failDispute({
      code: "invalid_payload",
      message: "Cuerpo de la petición inválido.",
    });
  }

  return { ok: true, value: parsed.data };
}

export function validateResolveInput(raw: unknown): ResolveValidationResult {
  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) {
    // A missing / invalid action is the only thing this body carries; surface
    // it specifically so the admin sees a precise message.
    return {
      ok: false,
      error: {
        code: "action_invalid",
        message: "Acción no válida.",
        field: "action",
      },
    };
  }

  return { ok: true, value: parsed.data };
}
