import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CATEGORY_LABELS,
  SOLVER_TYPE_LABELS,
  STATUS_LABELS,
} from "@/lib/reportLabels";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isCorroborated } from "@/lib/validation/corroboration";

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
  /** 'report' (original complaint) | 'resolution' (proof of fix). The UI splits
   * before/after on this field; the array order is unchanged. */
  kind: string;
};

/**
 * The PUBLIC identity of the verified solver who claimed/resolved a report.
 * Only present when the attributing profile has a `solver_profiles` row — a
 * staff resolution (profile with no public solver identity) yields `null`,
 * which is correct (no public badge), not an error.
 */
export type SolverAttribution = {
  handle: string;
  type: string;
  typeLabel: string;
  avatarUrl: string | null;
  /** This solver's standing resolved-reports count (subsystem C) — the compact
   * "· N resueltos" the attribution badge surfaces. Read from `solver_profiles`. */
  resolvedCount: number;
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
  /** The solver who claimed (→ en_proceso), if any and if they have a public
   * solver profile. `null` for unclaimed or staff-claimed reports. */
  claimedBy: SolverAttribution | null;
  /** The solver who resolved (→ resuelto), if any and if they have a public
   * solver profile. `null` for unresolved or staff-resolved reports. */
  resolvedBy: SolverAttribution | null;
  /** Count of VERIFIED (authenticated) corroborations — the badge input
   * (subsystem A). The author seeds the first verified confirmation. */
  verifiedCount: number;
  /** Count of ANONYMOUS corroborations — feeds priority only, NOT the badge. */
  anonCount: number;
  /** Whether `verifiedCount` clears the public "Corroborado" badge threshold. */
  corroborated: boolean;
  /** Whether the CURRENT viewer (when `viewerId` is supplied) has already
   * corroborated this report — drives the idempotent confirm CTA. Always `false`
   * for anonymous viewers (no `viewerId`). */
  hasValidated: boolean;
};

/** Row shape from the reports + category lookup (public columns only). */
type ReportRow = {
  id: string;
  status: string;
  created_at: string;
  description: string | null;
  categories: { slug: string } | null;
  // Attribution FKs to profiles(id) (NOT solver_profiles); the public
  // handle/type are fetched separately below.
  claimed_by: string | null;
  resolved_by: string | null;
  // Corroboration counters maintained by the migration-0018 triggers.
  verified_count: number;
  anon_count: number;
};

/** Row shape from the processed-media lookup. */
type MediaRow = {
  storage_path: string;
  type: string;
  width: number | null;
  height: number | null;
  kind: string;
};

/** Row shape from the public solver_profiles lookup (public columns only). */
type SolverProfileRow = {
  id: string;
  handle: string;
  type: string;
  avatar_url: string | null;
  resolved_count: number;
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
  viewerId?: string | null,
): Promise<ReportDetail | null> {
  // SCEN-003: a malformed id can never match a row — short-circuit to a 404
  // (avoids a Postgres `invalid input syntax for type uuid` 500).
  if (!UUID_RE.test(id)) return null;

  // Public columns only — `reporter_id` and `location` are intentionally absent.
  const { data: report, error: reportErr } = await client
    .from("reports")
    .select(
      "id, status, created_at, description, claimed_by, resolved_by, verified_count, anon_count, categories(slug)",
    )
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
    .select("storage_path, type, width, height, kind")
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
        kind: row.kind,
      };
    }),
  );

  const media = signed.filter((m): m is ReportDetailMedia => m !== null);

  // Solver attribution. claimed_by/resolved_by FK profiles(id), NOT
  // solver_profiles, so a PostgREST embed is impossible (and a staff member has
  // a profile but no solver_profiles row). One extra admin read fetches the
  // PUBLIC solver identity for the non-null ids; staff (no solver row) → null.
  const attribIds = [report.claimed_by, report.resolved_by].filter(
    (v): v is string => v !== null,
  );

  let solverById = new Map<string, SolverAttribution>();
  if (attribIds.length > 0) {
    const { data: profiles, error: profilesErr } = await client
      .from("solver_profiles")
      .select("id, handle, type, avatar_url, resolved_count")
      .in("id", attribIds)
      .returns<SolverProfileRow[]>();

    if (profilesErr) {
      throw new Error(`solver profile lookup failed: ${profilesErr.message}`);
    }

    solverById = new Map(
      (profiles ?? []).map((p) => [
        p.id,
        {
          handle: p.handle,
          type: p.type,
          typeLabel: SOLVER_TYPE_LABELS[p.type] ?? p.type,
          avatarUrl: p.avatar_url,
          resolvedCount: p.resolved_count,
        },
      ]),
    );
  }

  const claimedBy = report.claimed_by
    ? solverById.get(report.claimed_by) ?? null
    : null;
  const resolvedBy = report.resolved_by
    ? solverById.get(report.resolved_by) ?? null
    : null;

  // Per-viewer corroboration state (subsystem A). Anonymous viewers (no
  // `viewerId`) always get `false` — no query, and the confirm API is
  // idempotent so a stale `false` can never double-count. When a viewerId is
  // supplied, one admin EXISTS read resolves whether they already corroborated.
  let hasValidated = false;
  if (viewerId) {
    const { data: validation, error: validationErr } = await client
      .from("report_validations")
      .select("report_id")
      .eq("report_id", id)
      .eq("validator_id", viewerId)
      .maybeSingle<{ report_id: string }>();

    if (validationErr) {
      throw new Error(
        `report validation lookup failed: ${validationErr.message}`,
      );
    }
    hasValidated = validation !== null;
  }

  const category = report.categories?.slug ?? "";
  const status = report.status;
  const verifiedCount = report.verified_count;
  const anonCount = report.anon_count;

  return {
    id: report.id,
    category,
    categoryLabel: CATEGORY_LABELS[category] ?? category,
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    createdAt: report.created_at,
    description: report.description,
    media,
    claimedBy,
    resolvedBy,
    verifiedCount,
    anonCount,
    corroborated: isCorroborated(verifiedCount),
    hasValidated,
  };
}
