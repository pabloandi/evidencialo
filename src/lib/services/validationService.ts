import type { SupabaseClient } from "@supabase/supabase-js";

import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Validation service (subsystem A, chunk A2). One path over the
 * `validate_report` RPC (migration 0018): a citizen/witness corroborates that an
 * OPEN, visible report is real ("yo también lo veo").
 *
 * `validateReport` calls the SECURITY DEFINER RPC, which is the ONLY client
 * write path into `report_validations` — it gates validatability, inserts the
 * right identity row (authenticated via `auth.uid()` XOR anonymous via the
 * hashed IP), dedups via ON CONFLICT DO NOTHING (idempotent re-confirm), and
 * returns the FRESH aggregate counts read back from `reports`.
 *
 * Defaults to `createServerSupabase()` — the AUTHENTICATED server client bound
 * to the request's JWT — so `auth.uid()` resolves to the caller inside the RPC.
 * The client is injectable for unit tests.
 *
 * IMPORTANT — the RPC returns its counts via a `returns table(...)` SELECT, NOT
 * via `INSERT ... RETURNING`, so we do NOT chain `.select()` here (mirrors
 * `disputeService.ts`'s lesson). `data` arrives as an array; we take row 0.
 *
 * Postgres error CODES are normalized to typed errors so the route can map them
 * to HTTP statuses (mirrors `disputeService.ts`):
 *   - P0001 (report not open/visible) -> ReportNotValidatableError -> route 409
 *   - 22023 (empty ip_hash for anon)  -> InvalidInputError         -> route 400
 *   anything else -> generic Error -> route 500
 */

/**
 * The target report is not corroborable: it does not exist, is not open
 * (nuevo|en_proceso), or is hidden (RPC raises P0001). Route -> 409.
 */
export class ReportNotValidatableError extends Error {
  constructor(message = "report is not validatable") {
    super(message);
    this.name = "ReportNotValidatableError";
  }
}

/**
 * The RPC rejected the input (RPC raises 22023): an anonymous caller reached the
 * RPC with a null/empty ip_hash. Route -> 400.
 */
export class InvalidInputError extends Error {
  constructor(message = "invalid input") {
    super(message);
    this.name = "InvalidInputError";
  }
}

export type ValidateReportResult = {
  verifiedCount: number;
  anonCount: number;
  newlyAdded: boolean;
};

type RpcRow = {
  verified_count: number;
  anon_count: number;
  newly_added: boolean;
};

export async function validateReport(
  reportId: string,
  ipHash: string | null,
  client?: SupabaseClient,
): Promise<ValidateReportResult> {
  // Default to the AUTHENTICATED server client (async factory — can't be a
  // default-param value). Tests inject a fake client.
  const db = client ?? (await createServerSupabase());

  const { data, error } = await db.rpc("validate_report", {
    p_report_id: reportId,
    p_ip_hash: ipHash,
  });

  if (error) {
    // PostgREST surfaces the Postgres errcode in `error.code`.
    const code = error.code ?? "";
    const message = error.message ?? "";

    if (code === "P0001") {
      throw new ReportNotValidatableError(message || undefined);
    }
    if (code === "22023") {
      throw new InvalidInputError(message || undefined);
    }
    throw new Error(`validateReport failed: ${message || code}`);
  }

  // `returns table(...)` arrives as an array; take the single echoed row.
  const row = Array.isArray(data)
    ? (data[0] as RpcRow | undefined)
    : (data as RpcRow | null);
  if (!row) {
    // The RPC always returns a row on success (it SELECTs the report counts), so
    // a no-error empty result should not happen; guard defensively.
    throw new Error("validateReport failed: empty result");
  }

  return {
    verifiedCount: row.verified_count,
    anonCount: row.anon_count,
    newlyAdded: row.newly_added,
  };
}
