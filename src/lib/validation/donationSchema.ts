import { z } from "zod";

/**
 * Per-type validation + normalization for the donation-channel write path
 * (subsystem D, chunk D2). Mirrors `disputeSchema.ts`: parse the untrusted body
 * structurally, then return a single `{ ok, value } | { ok:false, error }`
 * result so the route maps the FIRST violation to one Spanish message (no
 * array). This is the SINGLE source of precise per-type format validation; the
 * DB CHECKs (migration 0020) are a coarse defense-in-depth backstop.
 *
 * Per the spec's "Validation rules" table:
 *   - nequi / daviplata → a Colombian mobile: 10 digits, `3`-prefixed
 *     (`/^3\d{9}$/`), stored digits-only (spaces/dashes stripped first).
 *   - bancolombia → an account number (digits, length 10–16) + an
 *     `account_kind ∈ {ahorros, corriente}` (REQUIRED).
 *   - paypal → a bare `paypal.me` username (`/^[A-Za-z0-9]{1,20}$/`) OR a
 *     `paypal.me` URL whose path is EXACTLY that username — any other host, or
 *     any extra path segment / query / fragment, is rejected (anti-phishing /
 *     open-redirect). Normalized to `https://paypal.me/<user>`. `account_kind`
 *     must be absent.
 *   - Coupling: `account_kind` is present IFF `type === 'bancolombia'`.
 *
 * AUTHORIZATION is never validated here — it is the route's gate + the DEFINER
 * RPC's `auth.uid()` owner check. A client-supplied `solver_id` (if any) is not
 * part of this schema and is never read.
 */

export const DONATION_TYPES = [
  "nequi",
  "daviplata",
  "bancolombia",
  "paypal",
] as const;

export type DonationType = (typeof DONATION_TYPES)[number];

export const ACCOUNT_KINDS = ["ahorros", "corriente"] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** A validated, normalized donation channel ready for the set RPC. */
export type ValidDonationChannel = {
  type: DonationType;
  /** Digits-only cell/account, or the normalized `https://paypal.me/<user>`. */
  value: string;
  /** Present only for bancolombia; null for every other type. */
  accountKind: AccountKind | null;
};

export type DonationValidationError = {
  code: string;
  message: string;
  field?: string;
};

export type DonationValidationResult =
  | { ok: true; value: ValidDonationChannel }
  | { ok: false; error: DonationValidationError };

const COLOMBIAN_CELL_RE = /^3\d{9}$/;
const BANCOLOMBIA_ACCOUNT_RE = /^\d{10,16}$/;
const PAYPAL_USER_RE = /^[A-Za-z0-9]{1,20}$/;

function fail(error: DonationValidationError): DonationValidationResult {
  return { ok: false, error };
}

/** Strip spaces and dashes so a copy-pasted "300 123 4567" still validates. */
function stripSeparators(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/**
 * Extract a `paypal.me` username from either a bare username or a full
 * `paypal.me` URL. Returns null when the input is not a clean `paypal.me`
 * reference. The URL form must have:
 *   - host exactly `paypal.me` or `www.paypal.me` (any other host rejected),
 *   - a single path segment that IS the username (no extra path),
 *   - NO query and NO fragment.
 */
function extractPaypalUser(raw: string): string | null {
  const trimmed = raw.trim();

  // Bare username (no scheme, no slash, no dot) → validate directly.
  if (PAYPAL_USER_RE.test(trimmed)) {
    return trimmed;
  }

  // Otherwise it must be a parseable absolute URL. A protocol-relative or
  // schemeless "paypal.me/user" is normalized to https for parsing so a user
  // who pastes the bare domain form is still accepted.
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // Only http(s) — reject javascript:, data:, etc.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // Host must be paypal.me (or www.paypal.me) — no other host, no userinfo.
  const host = url.hostname.toLowerCase();
  if (host !== "paypal.me" && host !== "www.paypal.me") return null;
  if (url.username || url.password) return null;

  // No query, no fragment, no port.
  if (url.search || url.hash || url.port) return null;

  // The path must be exactly one segment that is the username — reject
  // `paypal.me/user/extra`, `paypal.me/`, `paypal.me/user/`, etc.
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 1) return null;

  const user = segments[0]!;
  if (!PAYPAL_USER_RE.test(user)) return null;

  return user;
}

const rawSchema = z.object({
  type: z.enum(DONATION_TYPES),
  value: z.string().min(1).max(256),
  accountKind: z.enum(ACCOUNT_KINDS).optional().nullable(),
});

/**
 * Validate + normalize a donation channel body. Returns the FIRST violation as a
 * single Spanish-messaged error (never an array), matching the existing 422
 * copy style.
 */
export function validateDonationChannel(
  raw: unknown,
): DonationValidationResult {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? String(first.path[0]) : undefined;
    if (field === "type") {
      return fail({
        code: "type_invalid",
        message: "Tipo de canal no válido.",
        field: "type",
      });
    }
    if (field === "accountKind") {
      return fail({
        code: "account_kind_invalid",
        message: "El tipo de cuenta debe ser ahorros o corriente.",
        field: "accountKind",
      });
    }
    return fail({
      code: "invalid_payload",
      message: "Cuerpo de la petición inválido.",
    });
  }

  const { type, value, accountKind: rawKind } = parsed.data;
  const accountKind = rawKind ?? null;

  // --- Coupling: account_kind present IFF type === 'bancolombia'. ---
  if (type === "bancolombia" && accountKind === null) {
    return fail({
      code: "account_kind_required",
      message: "Bancolombia requiere el tipo de cuenta (ahorros o corriente).",
      field: "accountKind",
    });
  }
  if (type !== "bancolombia" && accountKind !== null) {
    return fail({
      code: "account_kind_forbidden",
      message: "El tipo de cuenta solo aplica a Bancolombia.",
      field: "accountKind",
    });
  }

  // --- Per-type value validation + normalization. ---
  switch (type) {
    case "nequi":
    case "daviplata": {
      const digits = stripSeparators(value);
      if (!COLOMBIAN_CELL_RE.test(digits)) {
        return fail({
          code: "cell_invalid",
          message:
            "El número celular debe tener 10 dígitos y empezar por 3.",
          field: "value",
        });
      }
      return { ok: true, value: { type, value: digits, accountKind: null } };
    }

    case "bancolombia": {
      const digits = stripSeparators(value);
      if (!BANCOLOMBIA_ACCOUNT_RE.test(digits)) {
        return fail({
          code: "account_invalid",
          message:
            "El número de cuenta debe tener entre 10 y 16 dígitos.",
          field: "value",
        });
      }
      return { ok: true, value: { type, value: digits, accountKind } };
    }

    case "paypal": {
      const user = extractPaypalUser(value);
      if (!user) {
        return fail({
          code: "paypal_invalid",
          message:
            "El usuario de PayPal no es válido. Usa tu usuario de paypal.me.",
          field: "value",
        });
      }
      return {
        ok: true,
        value: {
          type,
          value: `https://paypal.me/${user}`,
          accountKind: null,
        },
      };
    }

    default: {
      // Unreachable: the enum is exhausted above. Defensive only.
      return fail({
        code: "type_invalid",
        message: "Tipo de canal no válido.",
        field: "type",
      });
    }
  }
}
