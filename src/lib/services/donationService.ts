import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AccountKind,
  DonationType,
} from "@/lib/validation/donationSchema";

/**
 * Donation-channel service (subsystem D, chunk D2). Two thin wrappers over the
 * owner-gated DEFINER RPCs from migration 0020:
 *
 *   - `setDonationChannel`    → `set_solver_donation_channel`
 *   - `deleteDonationChannel` → `delete_solver_donation_channel`
 *
 * CRITICAL — the client is INJECTED, not defaulted here. The RPCs read
 * `auth.uid()` internally to derive `solver_id` (never a parameter), so the
 * route MUST pass the request-scoped AUTHENTICATED server client (the same one
 * `disputeService.fileDispute` uses) — calling these with the service-role admin
 * client would leave `auth.uid()` null and the owner gate would 42501. This
 * service therefore takes the client explicitly so the caller cannot get the
 * split wrong by omission. Tests inject a fake client.
 *
 * `solver_id` is NEVER a parameter — a solver can only ever write their own
 * channels (the SCEN-002 boundary). The route forwards no client solver id.
 *
 * Postgres error CODES are normalized to typed errors the route maps to HTTP
 * statuses (mirrors `disputeService.ts`):
 *   - 42501 (forbidden / caller is not a solver) → ForbiddenError      → 403
 *   - 23514 (allowlist / coupling CHECK)         → InvalidChannelError → 422
 *   - 22023 (request_meta too large)             → InvalidChannelError → 422
 *   - anything else                              → generic Error       → 500
 */

/** The caller is not the owning solver (RPC raised 42501). Route → 403. */
export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * The channel failed a DB CHECK — an unknown type, or the account_kind coupling
 * (bancolombia ⇒ kind required; every other type ⇒ kind forbidden), or the
 * request_meta bound (23514 / 22023). Route → 422.
 */
export class InvalidChannelError extends Error {
  constructor(message = "invalid donation channel") {
    super(message);
    this.name = "InvalidChannelError";
  }
}

/** The echoed channel row returned by `set_solver_donation_channel`. */
export type DonationChannelRow = {
  id: string;
  solver_id: string;
  type: DonationType;
  value: string;
  account_kind: AccountKind | null;
  qr_path: string | null;
  created_at: string;
  updated_at: string;
};

/** Route-supplied audit context folded into the history snapshot. */
export type RequestMeta = {
  ip?: string;
  ua?: string | null;
};

export type SetDonationChannelInput = {
  type: DonationType;
  value: string;
  accountKind: AccountKind | null;
  qrPath: string | null;
};

function mapRpcError(error: { code?: string; message?: string }): never {
  const code = error.code ?? "";
  const message = error.message ?? "";

  if (code === "42501") {
    throw new ForbiddenError(message || "forbidden");
  }
  // 23514 = CHECK violation (allowlist / coupling); 22023 = request_meta bound.
  if (code === "23514" || code === "22023") {
    throw new InvalidChannelError(message || undefined);
  }
  throw new Error(`donation channel RPC failed: ${message || code}`);
}

/**
 * Upsert the caller's donation channel of `input.type`. The client MUST be the
 * authenticated server client (so `auth.uid()` resolves to the caller). Returns
 * the echoed row.
 */
export async function setDonationChannel(
  client: SupabaseClient,
  input: SetDonationChannelInput,
  requestMeta: RequestMeta,
): Promise<DonationChannelRow> {
  const { data, error } = await client.rpc("set_solver_donation_channel", {
    p_type: input.type,
    p_value: input.value,
    p_account_kind: input.accountKind,
    p_qr_path: input.qrPath,
    p_request_meta: requestMeta,
  });

  if (error) {
    mapRpcError(error);
  }

  // `returns public.solver_donation_channels` arrives as the row object (or an
  // array of one, depending on PostgREST framing); normalize to the single row.
  const row = Array.isArray(data)
    ? (data[0] as DonationChannelRow | undefined)
    : (data as DonationChannelRow | null);
  if (!row) {
    // The RPC returns the upserted row on success, so a no-error empty result
    // should not happen; guard defensively.
    throw new Error("set_solver_donation_channel returned no row");
  }
  return row;
}

/**
 * Delete the caller's donation channel of `type`. Same client requirement as
 * `setDonationChannel`. The RPC returns void; success is the absence of an error.
 */
export async function deleteDonationChannel(
  client: SupabaseClient,
  type: DonationType,
  requestMeta: RequestMeta,
): Promise<void> {
  const { error } = await client.rpc("delete_solver_donation_channel", {
    p_type: type,
    p_request_meta: requestMeta,
  });

  if (error) {
    mapRpcError(error);
  }
}
