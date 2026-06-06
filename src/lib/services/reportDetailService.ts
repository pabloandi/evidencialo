import type { SupabaseClient } from "@supabase/supabase-js";

import { CATEGORY_LABELS, STATUS_LABELS } from "@/lib/reportLabels";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Public report detail read (step12) — the citizen-facing detail page's data.
 *
 * The media lives in the PRIVATE `report-media` bucket, so this server-only
 * service mints short-lived signed DOWNLOAD URLs (service-role) for each
 * SANITIZED object. It reads with the SERVICE-ROLE admin client (RLS bypassed)
 * but re-applies the public-read invariants EXPLICITLY (defense in depth, like
 * the map's `reports_in_view`):
 *   - the report must be `is_visible = true` — an invisible report is
 *     indistinguishable from a non-existent one (no existence leak, SCEN-002);
 *   - only `processing_state = 'processed'` media is shown — pending/failed
 *     (and therefore unsanitized) objects are excluded (SCEN-004).
 *
 * The returned shape carries ONLY public columns — never `reporter_id` and never
 * the precise `location` (SCEN-005). The client is injectable for testing.
 */

const BUCKET = "report-media";

/**
 * Signed-URL TTL (24h). The detail page is dynamic (service-role reads are
 * uncached), so a fresh URL is minted per request — the TTL only needs to
 * comfortably outlast a single viewing session. 24h is a generous, safe window.
 */
const SIGNED_URL_TTL_SECONDS = 86400;

// Canonical UUID (any version). A malformed id is rejected here so the page 404s
// (SCEN-003) WITHOUT a DB round-trip that would otherwise 500 on a bad cast.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReportDetailMedia = {
  signedUrl: string;
  type: string;
  width: number | null;
  height: number | null;
};

export type ReportDetail = {
  id: string;
  category: string;
  categoryLabel: string;
  status: string;
  statusLabel: string;
  createdAt: string;
  description: string | null;
  media: ReportDetailMedia[];
};

/** Row shape from the reports + category lookup (public columns only). */
type ReportRow = {
  id: string;
  status: string;
  created_at: string;
  description: string | null;
  categories: { slug: string } | null;
};

/** Row shape from the processed-media lookup. */
type MediaRow = {
  storage_path: string;
  type: string;
  width: number | null;
  height: number | null;
};

/**
 * Load the public detail of a VISIBLE report, or `null` when the report does not
 * exist, is not visible, or the id is malformed.
 *
 * Selects ONLY public columns; never returns `reporter_id` or `location`. Media
 * is the set of `processed` objects, each given a fresh signed download URL; a
 * media item whose URL fails to mint is skipped rather than failing the page.
 */
export async function getPublicReportDetail(
  id: string,
  client: SupabaseClient = createAdminSupabase(),
): Promise<ReportDetail | null> {
  // SCEN-003: a malformed id can never match a row — short-circuit to a 404
  // (avoids a Postgres `invalid input syntax for type uuid` 500).
  if (!UUID_RE.test(id)) return null;

  // Public columns only — `reporter_id` and `location` are intentionally absent.
  const { data: report, error: reportErr } = await client
    .from("reports")
    .select("id, status, created_at, description, categories(slug)")
    .eq("id", id)
    .eq("is_visible", true)
    .maybeSingle<ReportRow>();

  if (reportErr) {
    throw new Error(`report detail lookup failed: ${reportErr.message}`);
  }
  // SCEN-002: invisible == not-found (no existence leak).
  if (!report) return null;

  const { data: mediaRows, error: mediaErr } = await client
    .from("report_media")
    .select("storage_path, type, width, height")
    .eq("report_id", id)
    .eq("processing_state", "processed")
    .order("created_at", { ascending: true })
    .order("storage_path", { ascending: true })
    .returns<MediaRow[]>();

  if (mediaErr) {
    throw new Error(`report media lookup failed: ${mediaErr.message}`);
  }

  // Mint a signed download URL per processed object IN PARALLEL. An object whose
  // URL fails to mint (e.g. the upload never landed) is dropped, not fatal.
  const signed = await Promise.all(
    (mediaRows ?? []).map(async (row): Promise<ReportDetailMedia | null> => {
      const { data, error } = await client.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
      if (error || !data) return null;
      return {
        signedUrl: data.signedUrl,
        type: row.type,
        width: row.width,
        height: row.height,
      };
    }),
  );

  const media = signed.filter((m): m is ReportDetailMedia => m !== null);

  const category = report.categories?.slug ?? "";
  const status = report.status;

  return {
    id: report.id,
    category,
    categoryLabel: CATEGORY_LABELS[category] ?? category,
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    createdAt: report.created_at,
    description: report.description,
    media,
  };
}
