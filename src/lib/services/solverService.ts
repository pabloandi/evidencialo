import type { SupabaseClient } from "@supabase/supabase-js";

import { CATEGORY_LABELS, SOLVER_TYPE_LABELS } from "@/lib/reportLabels";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Public solver profile reads (chunk B2.4) — the `/solucionadores/[handle]`
 * page's data.
 *
 * Two server-only reads via the SERVICE-ROLE admin client (RLS bypassed) that
 * re-apply the public-read invariants EXPLICITLY, exactly like
 * `reportDetailService` (defense in depth):
 *   - the returned shapes carry ONLY public columns — never `reporter_id`,
 *     never the precise `location`, never `verified_by` (SCEN-008, no PII
 *     beyond the public solver profile);
 *   - resolved-report media lives in the PRIVATE `report-media` bucket, so a
 *     short-lived signed DOWNLOAD URL is minted per thumbnail; a thumb whose URL
 *     fails to mint is omitted, not fatal;
 *   - only `processing_state = 'processed'` (and therefore sanitized) media is
 *     shown; only `is_visible = true`, `status = 'resuelto'` reports are listed.
 *
 * Handle lookup is CASE-INSENSITIVE (the DB has a `lower(handle)` unique index)
 * AND injection-safe: PostgREST `ilike` treats `%` / `_` as wildcards, so the
 * input is escaped before the filter — a handle literally containing `%` can
 * only match that same literal, never act as a wildcard. The client is
 * injectable for testing.
 */

const BUCKET = "report-media";

/** Signed-URL TTL (24h) — mirrors reportDetailService. Fresh per request. */
const SIGNED_URL_TTL_SECONDS = 86400;

export type SolverProfile = {
  id: string;
  handle: string;
  type: string;
  typeLabel: string;
  bio: string | null;
  avatarUrl: string | null;
  links: Record<string, unknown>;
};

/** A before/after thumbnail: a freshly minted signed URL + its media type. */
export type SolverReportThumb = {
  signedUrl: string;
  type: string;
};

export type SolverResolvedReport = {
  id: string;
  category: string;
  categoryLabel: string;
  createdAt: string;
  resolvedAt: string | null;
  /** First processed `kind='report'` media — the "before". null if none/unsigned. */
  beforeThumb: SolverReportThumb | null;
  /** First processed `kind='resolution'` media — the "after". null if none/unsigned. */
  afterThumb: SolverReportThumb | null;
};

/** Row shape from the public solver_profiles lookup (public columns only). */
type SolverProfileRow = {
  id: string;
  handle: string;
  type: string;
  bio: string | null;
  avatar_url: string | null;
  links: Record<string, unknown> | null;
};

/** Row shape from the resolved-reports lookup (public columns only). */
type ResolvedReportRow = {
  id: string;
  created_at: string;
  resolved_at: string | null;
  categories: { slug: string } | null;
};

/** Row shape from the per-report thumbnail lookup. */
type ThumbRow = {
  storage_path: string;
  type: string;
};

/**
 * Escape the LIKE/ILIKE metacharacters in a handle so PostgREST `ilike` matches
 * the EXACT literal (case-insensitively) instead of treating `%`/`_` as
 * wildcards. The backslash itself is escaped first so it can't re-enable a
 * wildcard. With the default escape char (`\`), `\%`, `\_` and `\\` are literals.
 */
function escapeIlike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Load the PUBLIC profile of a verified solver by handle (case-insensitive), or
 * `null` when no such handle exists (→ the page 404s) or the handle is
 * empty/malformed.
 *
 * Selects ONLY public columns; never returns `verified_by` / `verified_at`.
 */
export async function getSolverProfileByHandle(
  handle: string,
  client: SupabaseClient = createAdminSupabase(),
): Promise<SolverProfile | null> {
  // Guard an empty/whitespace handle before querying — it can never match a row
  // and an unescaped bare `%` would otherwise match the FIRST profile.
  const trimmed = handle?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const { data, error } = await client
    .from("solver_profiles")
    .select("id, handle, type, bio, avatar_url, links")
    // Case-insensitive (ilike) + injection-safe (metachars escaped → literal
    // match). The DB's lower(handle) unique index guarantees at most one row.
    .ilike("handle", escapeIlike(trimmed))
    .maybeSingle<SolverProfileRow>();

  if (error) {
    throw new Error(`solver profile lookup failed: ${error.message}`);
  }
  if (!data) return null;

  return {
    id: data.id,
    handle: data.handle,
    type: data.type,
    typeLabel: SOLVER_TYPE_LABELS[data.type] ?? data.type,
    bio: data.bio,
    avatarUrl: data.avatar_url,
    links: data.links ?? {},
  };
}

/**
 * Mint a signed download URL for the FIRST processed media of a given `kind`
 * for a report (the before/after thumbnail), or `null` when there is none or
 * the URL fails to mint (non-fatal — the card simply omits that side).
 */
async function loadThumb(
  client: SupabaseClient,
  reportId: string,
  kind: "report" | "resolution",
): Promise<SolverReportThumb | null> {
  const { data, error } = await client
    .from("report_media")
    .select("storage_path, type")
    .eq("report_id", reportId)
    .eq("kind", kind)
    .eq("processing_state", "processed")
    .order("created_at", { ascending: true })
    .order("storage_path", { ascending: true })
    .limit(1)
    .maybeSingle<ThumbRow>();

  if (error || !data) return null;

  const { data: signed, error: signErr } = await client.storage
    .from(BUCKET)
    .createSignedUrl(data.storage_path, SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed) return null;

  return { signedUrl: signed.signedUrl, type: data.type };
}

/**
 * List a solver's PUBLIC resolved reports (newest `resolved_at` first), each
 * with its before/after thumbnail. Only `resuelto` + `is_visible = true`
 * reports are returned — never PII (`reporter_id`/`location` are never selected).
 *
 * A solver with zero resolutions returns `[]` (the page renders an empty state;
 * only an UNKNOWN handle 404s).
 */
export async function getSolverResolvedReports(
  solverId: string,
  client: SupabaseClient = createAdminSupabase(),
): Promise<SolverResolvedReport[]> {
  // Public columns only — `reporter_id` and `location` are intentionally absent.
  const { data: reports, error } = await client
    .from("reports")
    .select("id, created_at, resolved_at, categories(slug)")
    .eq("resolved_by", solverId)
    .eq("status", "resuelto")
    .eq("is_visible", true)
    .order("resolved_at", { ascending: false })
    .returns<ResolvedReportRow[]>();

  if (error) {
    throw new Error(`solver resolved reports lookup failed: ${error.message}`);
  }

  // Fetch both thumbnails per report IN PARALLEL across all reports.
  return Promise.all(
    (reports ?? []).map(async (row): Promise<SolverResolvedReport> => {
      const [beforeThumb, afterThumb] = await Promise.all([
        loadThumb(client, row.id, "report"),
        loadThumb(client, row.id, "resolution"),
      ]);
      const category = row.categories?.slug ?? "";
      return {
        id: row.id,
        category,
        categoryLabel: CATEGORY_LABELS[category] ?? category,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        beforeThumb,
        afterThumb,
      };
    }),
  );
}
