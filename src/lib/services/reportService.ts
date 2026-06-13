import type { SupabaseClient } from "@supabase/supabase-js";

import type { Bbox } from "@/lib/geo";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createReadSupabase } from "@/lib/supabase/read";
import { isCorroborated } from "@/lib/validation/corroboration";
import type {
  ValidMediaInput,
  ValidReportInput,
} from "@/lib/validation/reportSchema";

/**
 * Report creation service (step05) — the hybrid write path.
 *
 * A report is born invisible. The client declares its media up front so the
 * server enforces limits; the report row and ALL its `report_media` rows are
 * created ATOMICALLY by the `create_report` RPC (one transaction → no orphan
 * report, no poisoned replay, race-safe idempotency via `on conflict do
 * nothing`). The service then mints one signed upload URL per media item to a
 * PRIVATE Storage bucket. EXIF/metadata sanitization runs asynchronously after
 * upload (step07), never inline.
 *
 * Writes go through the SERVICE-ROLE admin client (RLS bypassed); callers MUST
 * validate input first. The client is injectable for testing.
 */

const BUCKET = "report-media";

/** Thrown when the submitted category slug does not exist. Route -> 422. */
export class CategoryInvalidError extends Error {
  constructor(public readonly category: string) {
    super(`Unknown category slug: ${category}`);
    this.name = "CategoryInvalidError";
  }
}

export type CreatedMedia = {
  id: string;
  type: string;
  signedUrl: string;
  token: string;
  path: string;
};

export type CreateReportResult = {
  report: { id: string };
  media: CreatedMedia[];
  idempotent: boolean;
};

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? "bin";
}

/**
 * Deterministic per-report storage path so a retry addresses the same object.
 * The report id is not known until insert, so the path uses a stable prefix the
 * RPC echoes back; here we build the per-index suffix from the mime type.
 *
 * Exported so the resolution-media path (B2.2a) reuses the EXACT same suffix
 * scheme — proof objects land at `<report_id>/resolution/<index>.<ext>` while
 * complaint media lands at `<report_id>/<index>.<ext>`.
 */
export function mediaPathSuffix(index: number, item: ValidMediaInput): string {
  return `${index}.${extForMime(item.mime)}`;
}

/** Shape returned by the `create_report` RPC (jsonb). */
type RpcResult = {
  report_id: string;
  idempotent: boolean;
  media: Array<{ id: string; type: string; storage_path: string }>;
};

async function signUpload(
  client: SupabaseClient,
  path: string,
): Promise<{ signedUrl: string; token: string; path: string }> {
  // upsert:true so a retry after a partial upload re-issues a URL for an
  // already-existing object instead of failing with a 409 (FIX 2 / SCEN-002).
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
 * Create a report (+ its media) atomically and mint signed upload URLs.
 *
 * `reporterId` associates the new report with its author (step14): the POST
 * route forwards the session user id, so a signed-in citizen's report becomes
 * visible to them in `/mis-reportes` via the `reports_select_own` RLS policy.
 * `null` (the default) keeps the report anonymous — unchanged behavior for
 * anonymous creates and every existing caller that omits the argument.
 */
export async function createReport(
  input: ValidReportInput,
  idempotencyKey?: string,
  reporterId: string | null = null,
  client: SupabaseClient = createAdminSupabase(),
): Promise<CreateReportResult> {
  // 1. Resolve category slug -> id. Unknown slug is a client error (SCEN-007).
  // Done BEFORE the RPC so the route can map it to a 422 without touching the
  // write transaction.
  const { data: category, error: catErr } = await client
    .from("categories")
    .select("id")
    .eq("slug", input.category)
    .maybeSingle();

  if (catErr) {
    throw new Error(`Category lookup failed: ${catErr.message}`);
  }
  if (!category) {
    throw new CategoryInvalidError(input.category);
  }

  // 2. Build the deterministic storage paths in the service so the persisted
  // path equals the signed path. The id prefix is unknown pre-insert, so paths
  // are relative suffixes; the RPC stores them verbatim and echoes them back.
  const mediaPayload = input.media.map((item, index) => ({
    storage_path: mediaPathSuffix(index, item),
    type: item.type,
    duration_s: item.type === "video" ? (item.duration_s ?? null) : null,
  }));

  // 3. Atomic report + media creation (one transaction). Idempotency is handled
  // inside the RPC via `on conflict do nothing`, so no 23505 handling here.
  const { data, error } = await client.rpc("create_report", {
    p_category_id: category.id,
    p_lng: input.lng,
    p_lat: input.lat,
    p_description: input.description ?? null,
    p_idempotency_key: idempotencyKey ?? null,
    p_media: mediaPayload,
    p_reporter_id: reporterId,
  });

  if (error) {
    throw new Error(`create_report RPC failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("create_report RPC returned no data.");
  }

  const result = data as RpcResult;

  // 4. Mint signed upload URLs in PARALLEL for the persisted media paths.
  const media: CreatedMedia[] = await Promise.all(
    result.media.map(async (row) => {
      const signed = await signUpload(client, row.storage_path);
      return {
        id: row.id,
        type: row.type,
        signedUrl: signed.signedUrl,
        token: signed.token,
        path: signed.path,
      };
    }),
  );

  return {
    report: { id: result.report_id },
    media,
    idempotent: result.idempotent,
  };
}

/**
 * One public report marker as returned to the open map (step11).
 *
 * PUBLIC FIELDS ONLY. `reporter_id` and the precise street `address` are PII and
 * are NEVER exposed here — the shape is pinned to the `reports_in_view` RETURNS
 * TABLE columns (public-map-bbox.scenarios.md, SCEN-004). Coordinates are public
 * by nature of a map pin.
 *
 * The `*By*` attribution fields (subsystem B, B2.3) carry the public solver
 * handle + type when a report was claimed/resolved BY A VERIFIED SOLVER. They are
 * `null` when the report is unattributed OR was attributed to a non-solver actor
 * (staff/admin) — the RPC's LEFT JOIN to `solver_profiles` yields NULL there. The
 * map popup renders "Resuelto por @handle" / "En proceso por @handle" from these.
 */
export type ReportMarker = {
  id: string;
  lng: number;
  lat: number;
  category: string;
  status: string;
  created_at: string;
  claimedByHandle: string | null;
  claimedByType: string | null;
  resolvedByHandle: string | null;
  resolvedByType: string | null;
  /** Verified-confirmation count (subsystem A), exposed by `reports_in_view`
   * since migration 0018. Feeds the map popup's "Corroborado" badge. */
  verifiedCount: number;
  /** Anonymous-confirmation count — informational only, NOT a badge input. */
  anonCount: number;
  /** Whether `verifiedCount` clears the public "Corroborado" badge threshold. */
  corroborated: boolean;
};

/**
 * Raw row shape returned by the `reports_in_view` RPC. The public-field columns
 * are already camelCase-compatible (`id`, `lng`, …, `created_at`), but the
 * attribution columns are snake_case and must be mapped onto `ReportMarker`.
 */
type ReportInViewRow = {
  id: string;
  lng: number;
  lat: number;
  category: string;
  status: string;
  created_at: string;
  claimed_by_handle: string | null;
  claimed_by_type: string | null;
  resolved_by_handle: string | null;
  resolved_by_type: string | null;
  verified_count: number;
  anon_count: number;
};

/** Default cap on rows returned per bbox read (overridable per call/test). */
export const DEFAULT_BBOX_CAP = 2000;

/**
 * Read the visible reports inside a bounding box for the public map (step11).
 *
 * Delegates to the SECURITY DEFINER `reports_in_view` RPC, which uses the GIST
 * index, orders `created_at desc, id`, and returns ONLY `is_visible=true` rows
 * with public fields. This is a public, cacheable read, so it uses the stateless
 * ANON read client by default (no cookies, no session); the client is injectable
 * for testing. The caller MUST have validated the bbox (see `parseBbox`) before
 * calling — this function passes the four floats straight to PostGIS.
 *
 * A dense viewport is truncated DETERMINISTICALLY: the RPC is asked for
 * `p_limit = cap + 1` (one sentinel row beyond the cap) so overflow is detected
 * without a second query. When more than `cap` rows match, the extra row is
 * dropped and `truncated` is `true` so the caller can signal the loss instead of
 * dropping rows silently (public-map-bbox-hardening.scenarios.md SCEN-H03).
 */
export async function listInBbox(
  bbox: Bbox,
  client: SupabaseClient = createReadSupabase(),
  cap: number = DEFAULT_BBOX_CAP,
): Promise<{ markers: ReportMarker[]; truncated: boolean }> {
  const { data, error } = await client.rpc("reports_in_view", {
    min_lng: bbox.minLng,
    min_lat: bbox.minLat,
    max_lng: bbox.maxLng,
    max_lat: bbox.maxLat,
    p_limit: cap + 1,
  });

  if (error) {
    throw new Error(`reports_in_view RPC failed: ${error.message}`);
  }

  const rows = (data ?? []) as ReportInViewRow[];
  const truncated = rows.length > cap;
  const kept = truncated ? rows.slice(0, cap) : rows;

  // Map snake_case RPC columns onto the camelCase ReportMarker. The public
  // fields pass through unchanged; the four attribution columns are renamed
  // (claimed_by_handle → claimedByHandle, …) so the popup never has to know the
  // DB column names.
  const markers: ReportMarker[] = kept.map((row) => ({
    id: row.id,
    lng: row.lng,
    lat: row.lat,
    category: row.category,
    status: row.status,
    created_at: row.created_at,
    claimedByHandle: row.claimed_by_handle ?? null,
    claimedByType: row.claimed_by_type ?? null,
    resolvedByHandle: row.resolved_by_handle ?? null,
    resolvedByType: row.resolved_by_type ?? null,
    verifiedCount: row.verified_count,
    anonCount: row.anon_count,
    corroborated: isCorroborated(row.verified_count),
  }));

  return { markers, truncated };
}
