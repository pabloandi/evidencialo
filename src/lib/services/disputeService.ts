import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Dispute service (subsystem B, chunk B3.2). Two paths over the
 * `report_disputes` table + `resolve_dispute` RPC (migration 0017):
 *
 *   - `fileDispute` — anyone (anon + authenticated) flags a `resuelto` report's
 *     resolution as false/abusive. A `return=minimal` INSERT (no chained
 *     `.select()`); the table's RLS WITH CHECK is the real boundary (status must
 *     be 'open', created_by self/null, the report must be `resuelto`). The
 *     partial unique index coalesces dispute spam.
 *
 *     IMPORTANT — do NOT chain `.select()` here. `report_disputes` has an
 *     admin-only SELECT policy, so a non-admin filer cannot read the row back; an
 *     `INSERT ... RETURNING` (what `.select()` emits) forces a SELECT-policy check
 *     the filer fails, sinking the whole insert with 42501. We instead generate
 *     the id app-side and insert with `return=minimal`, then return that id.
 *   - `resolveDispute` — admin-only review (uphold | revert) over the
 *     SECURITY DEFINER RPC, which enforces `private.is_admin()`.
 *
 * Both default to `createServerSupabase()` — the AUTHENTICATED server client
 * bound to the request's JWT — so `auth.uid()` / `private.is_admin()` resolve to
 * the caller. The client is injectable for unit tests.
 *
 * Postgres error CODES are normalized to typed errors so the route can map them
 * to HTTP statuses (mirrors `statusService.ts`):
 *   fileDispute:
 *     - 23505 (unique violation) -> DisputeExistsError        -> route 409
 *     - 42501 (RLS WITH CHECK)   -> ReportNotDisputableError  -> route 409
 *   resolveDispute:
 *     - 42501 (not admin)        -> ForbiddenError              -> route 403
 *     - P0002 (dispute missing)  -> DisputeNotFoundError        -> route 404
 *     - P0001 (already resolved) -> DisputeAlreadyResolvedError -> route 409
 *   anything else -> generic Error -> route 500
 */

/**
 * An `open` dispute already exists for this report (partial-unique 23505). The
 * report can be disputed again only after the open one is reviewed. Route -> 409.
 */
export class DisputeExistsError extends Error {
  constructor(message = "an open dispute already exists for this report") {
    super(message);
    this.name = "DisputeExistsError";
  }
}

/**
 * The INSERT failed the table's RLS WITH CHECK (42501): the target report is not
 * `resuelto`, or the row was forged (status != 'open' / created_by spoofed).
 * Route -> 409.
 */
export class ReportNotDisputableError extends Error {
  constructor(message = "report is not disputable") {
    super(message);
    this.name = "ReportNotDisputableError";
  }
}

/** The caller is not an admin (RPC `private.is_admin()` refused). Route -> 403. */
export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** No dispute matches the given id (RPC P0002). Route -> 404. */
export class DisputeNotFoundError extends Error {
  constructor(public readonly disputeId: string) {
    super(`dispute not found: ${disputeId}`);
    this.name = "DisputeNotFoundError";
  }
}

/**
 * The dispute was already reviewed (upheld/reverted) — no double-processing
 * (RPC P0001). Route -> 409.
 */
export class DisputeAlreadyResolvedError extends Error {
  constructor(message = "dispute already resolved") {
    super(message);
    this.name = "DisputeAlreadyResolvedError";
  }
}

export type FileDisputeResult = {
  id: string;
};

export type ResolveDisputeResult = {
  dispute_id: string;
  dispute_status: string;
  report_status: string;
};

type RpcRow = {
  dispute_id: string;
  dispute_status: string;
  report_status: string;
};

export async function fileDispute(
  reportId: string,
  reason: string | null,
  userId: string | null,
  client?: SupabaseClient,
): Promise<FileDisputeResult> {
  // Default to the AUTHENTICATED server client (async factory — can't be a
  // default-param value). Tests inject a fake client.
  const db = client ?? (await createServerSupabase());

  // Generate the id ourselves so we can return it without reading the row back
  // (see the header note: the admin-only SELECT policy forbids the filer from
  // selecting it, so we MUST insert with `return=minimal` / no `.select()`).
  const id = randomUUID();

  const { error } = await db.from("report_disputes").insert({
    id,
    report_id: reportId,
    reason,
    created_by: userId,
    status: "open",
  });

  if (error) {
    // PostgREST surfaces the Postgres errcode in `error.code`.
    const code = error.code ?? "";
    const message = error.message ?? "";

    if (code === "23505") {
      throw new DisputeExistsError(message || undefined);
    }
    // 42501 = RLS WITH CHECK rejected: not a `resuelto` report, or a forged row.
    if (code === "42501") {
      throw new ReportNotDisputableError(message || undefined);
    }
    throw new Error(`fileDispute failed: ${message || code}`);
  }

  return { id };
}

export async function resolveDispute(
  disputeId: string,
  action: "uphold" | "revert",
  client?: SupabaseClient,
): Promise<ResolveDisputeResult> {
  const db = client ?? (await createServerSupabase());

  const { data, error } = await db.rpc("resolve_dispute", {
    p_dispute_id: disputeId,
    p_action: action,
  });

  if (error) {
    const code = error.code ?? "";
    const message = error.message ?? "";

    if (code === "42501") {
      throw new ForbiddenError(message || "forbidden");
    }
    if (code === "P0002") {
      throw new DisputeNotFoundError(disputeId);
    }
    if (code === "P0001") {
      throw new DisputeAlreadyResolvedError(message || undefined);
    }
    throw new Error(`resolve_dispute failed: ${message || code}`);
  }

  // `returns table(...)` arrives as an array; take the single echoed row.
  const row = Array.isArray(data)
    ? (data[0] as RpcRow | undefined)
    : (data as RpcRow | null);
  if (!row) {
    // The RPC raises on every failure path, so a no-error empty result should
    // not happen; guard defensively -> not found.
    throw new DisputeNotFoundError(disputeId);
  }

  return {
    dispute_id: row.dispute_id,
    dispute_status: row.dispute_status,
    report_status: row.report_status,
  };
}
