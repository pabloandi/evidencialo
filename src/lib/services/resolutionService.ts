import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  type CreatedMedia,
  mediaPathSuffix,
} from "@/lib/services/reportService";
import type { ValidMediaInput } from "@/lib/validation/reportSchema";

/**
 * Resolution-proof attach service (chunk B2.2a) — the net-new write path that
 * adds PROOF media to an EXISTING report so it can later be resolved (the
 * universal proof gate in 0015 requires >=1 processed kind='resolution' media).
 *
 * `create_report` (step05) only mints media at CREATION; this is the equivalent
 * path for an already-existing report. It mirrors that flow: the
 * `attach_resolution_media` DEFINER RPC inserts the kind='resolution' rows and
 * echoes back their persisted storage paths; the service then mints one signed
 * upload URL per row to the PRIVATE `report-media` bucket. EXIF/metadata
 * sanitization runs asynchronously after upload (image → /api/media, video →
 * the sanitizer), exactly as for complaint media — both are kind-agnostic, so a
 * resolution image reaches processing_state='processed' the same way.
 *
 * TWO clients, by design (same split the rest of the codebase uses):
 *   - the RPC runs through the AUTHENTICATED server client (JWT-bound) so
 *     `auth.uid()` / `private.is_staff()` / `private.is_solver()` resolve to the
 *     CALLER inside the DEFINER function — that is the real authz boundary.
 *   - `createSignedUploadUrl` on a PRIVATE bucket needs storage privileges, so
 *     it runs through the SERVICE-ROLE admin client (RLS bypassed). Both clients
 *     are injectable for testing.
 *
 * The RPC's Postgres error CODES are normalized to typed errors so the route can
 * map them to HTTP statuses (mirrors statusService's taxonomy):
 *   - 42501 (forbidden)        -> ForbiddenError       -> route 403
 *   - P0002 (report not found) -> ReportNotFoundError  -> route 404
 *   - anything else            -> generic Error        -> route 500
 */

const BUCKET = "report-media";

/** The caller is not staff/admin/solver (DB-layer authz refused). Route -> 403. */
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

export type AttachResolutionMediaResult = {
  media: CreatedMedia[];
};

/** Shape returned by the `attach_resolution_media` RPC (jsonb). */
type RpcResult = {
  media: Array<{ id: string; type: string; storage_path: string }>;
};

async function signUpload(
  client: SupabaseClient,
  path: string,
): Promise<{ signedUrl: string; token: string; path: string }> {
  // upsert:true so a retry after a partial upload re-issues a URL for an
  // already-existing object instead of failing with a 409 (mirrors signUpload
  // in reportService).
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
  if (error || !data) {
    throw new Error(
      `Failed to create signed upload URL for ${path}: ${error?.message ?? "no data"}`,
    );
  }
  return { signedUrl: data.signedUrl, token: data.token, path: data.path };
}

/**
 * Attach resolution proof media to an existing report and mint signed upload
 * URLs. The caller MUST have validated `mediaInput` (same limits as report
 * creation — see reportSchema) before calling.
 */
export async function attachResolutionMedia(
  reportId: string,
  mediaInput: ValidMediaInput[],
  authClient?: SupabaseClient,
  adminClient: SupabaseClient = createAdminSupabase(),
): Promise<AttachResolutionMediaResult> {
  // The RPC must see the caller's JWT (its is_staff/is_solver gate reads
  // auth.uid()), so default to the AUTHENTICATED server client. Async factory →
  // can't be a default-param value. Tests inject a fake client.
  const db = authClient ?? (await createServerSupabase());

  // Build the deterministic per-item suffixes in the service so the persisted
  // path equals the signed path (the RPC stores them verbatim, prefixing
  // `<report_id>/resolution/`). REUSE reportService's suffix scheme so proof and
  // complaint media share one path convention.
  const mediaPayload = mediaInput.map((item, index) => ({
    storage_path: mediaPathSuffix(index, item),
    type: item.type,
    duration_s: item.type === "video" ? (item.duration_s ?? null) : null,
  }));

  const { data, error } = await db.rpc("attach_resolution_media", {
    p_report_id: reportId,
    p_media: mediaPayload,
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
    throw new Error(`attach_resolution_media failed: ${message || code}`);
  }
  if (!data) {
    throw new Error("attach_resolution_media RPC returned no data.");
  }

  const result = data as RpcResult;

  // Mint signed upload URLs in PARALLEL for the persisted media paths, via the
  // ADMIN client (storage privileges on the private bucket).
  const media: CreatedMedia[] = await Promise.all(
    result.media.map(async (row) => {
      const signed = await signUpload(adminClient, row.storage_path);
      return {
        id: row.id,
        type: row.type,
        signedUrl: signed.signedUrl,
        token: signed.token,
        path: signed.path,
      };
    }),
  );

  return { media };
}
