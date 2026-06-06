import type { SupabaseClient } from "@supabase/supabase-js";

import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Staff status-change service (step13). Thin wrapper over the
 * `change_report_status` SECURITY DEFINER RPC, which performs the audited,
 * atomic write (status + history row + resolved_at) and enforces the DB-layer
 * `private.is_staff()` gate.
 *
 * Called through `createServerSupabase()` — the AUTHENTICATED server client
 * bound to the request's JWT — so `auth.uid()` / `private.is_staff()` resolve to
 * the caller inside the RPC. The client is injectable for unit tests.
 *
 * The RPC's Postgres error CODES are normalized to typed errors so the route can
 * map them to HTTP statuses (mirrors the error-taxonomy style of
 * `mediaService.ts`):
 *   - 42501 (forbidden)        -> ForbiddenError       -> route 403
 *   - P0002 (report not found) -> ReportNotFoundError  -> route 404
 *   - anything else            -> generic Error        -> route 500
 */

/** The caller is not staff/admin (DB-layer authz refused). Route -> 403. */
export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** No report matches the given id. Route -> 404. */
export class ReportNotFoundError extends Error {
  constructor(public readonly reportId: string) {
    super(`report not found: ${reportId}`);
    this.name = "ReportNotFoundError";
  }
}

export type ChangeStatusResult = {
  id: string;
  status: string;
  resolved_at: string | null;
};

type RpcRow = {
  id: string;
  status: string;
  resolved_at: string | null;
};

export async function changeReportStatus(
  reportId: string,
  toStatus: string,
  note: string | null,
  client?: SupabaseClient,
): Promise<ChangeStatusResult> {
  // Default to the AUTHENTICATED server client (async factory — can't be a
  // default-param value). Tests inject a fake client.
  const db = client ?? (await createServerSupabase());

  const { data, error } = await db.rpc("change_report_status", {
    p_report_id: reportId,
    p_to_status: toStatus,
    p_note: note,
  });

  if (error) {
    // PostgREST surfaces the Postgres errcode in `error.code`; fall back to a
    // message scan in case a layer rewrites it.
    const code = error.code ?? "";
    const message = error.message ?? "";

    if (code === "42501" || /forbidden/i.test(message)) {
      throw new ForbiddenError(message || "forbidden");
    }
    if (code === "P0002" || /not found/i.test(message)) {
      throw new ReportNotFoundError(reportId);
    }
    throw new Error(`change_report_status failed: ${message || code}`);
  }

  // `returns table(...)` arrives as an array; take the single echoed row. An
  // empty result with no error should not happen (the RPC raises on no row), but
  // guard defensively -> not found.
  const row = Array.isArray(data) ? (data[0] as RpcRow | undefined) : (data as RpcRow | null);
  if (!row) {
    throw new ReportNotFoundError(reportId);
  }

  return { id: row.id, status: row.status, resolved_at: row.resolved_at };
}
