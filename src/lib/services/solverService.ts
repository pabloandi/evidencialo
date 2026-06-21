import type { SupabaseClient } from "@supabase/supabase-js";

import { CATEGORY_LABELS, SOLVER_TYPE_LABELS } from "@/lib/reportLabels";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type {
  AccountKind,
  DonationType,
} from "@/lib/validation/donationSchema";

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

/** The public-read bucket holding uploaded donation-rail QR images (D1). */
const DONATION_QR_BUCKET = "donation-qr";

/**
 * The exact normalized shape a `paypal` channel value must have (mirrors the Zod
 * route validator + `paypalQrSvg`'s internal guard). The DB CHECK on `value` is
 * length-only, so a malformed `paypal` row CAN exist (a direct RPC call, an
 * import, an admin insert). We re-validate it at the READ layer and DROP a bad
 * one before it reaches `DonationBlock` — where `paypalQrSvg` would throw and, in
 * an async RSC, 500 the entire public profile. Degrade, never crash.
 */
const PAYPAL_PUBLIC_URL_RE = /^https:\/\/paypal\.me\/[A-Za-z0-9]{1,20}$/;

/** Signed-URL TTL (24h) — mirrors reportDetailService. Fresh per request. */
const SIGNED_URL_TTL_SECONDS = 86400;

/**
 * A public donation channel for the "Apóyalo" block (subsystem D, chunk D3).
 *
 * `value` is the displayed cell/account, or the normalized `https://paypal.me/<user>`
 * URL. `qrUrl` is the PUBLIC storage URL of the uploaded QR image for a Colombian
 * rail; it is `null` for PayPal (its QR is GENERATED, never uploaded) and for any
 * rail with no uploaded QR yet. PayPal's generated SVG is produced in the block
 * itself (`paypalQrSvg`), not here.
 */
export type DonationChannel = {
  type: DonationType;
  value: string;
  /** Present only for bancolombia; null for every other type. */
  accountKind: AccountKind | null;
  /** Public URL of the uploaded rail QR, or null (paypal / no upload). */
  qrUrl: string | null;
};

export type SolverProfile = {
  id: string;
  handle: string;
  type: string;
  typeLabel: string;
  bio: string | null;
  avatarUrl: string | null;
  links: Record<string, unknown>;
  /** Standing `resuelto AND is_visible` reports by this solver — equals the
   * profile wall. Maintained by the migration-0019 recompute triggers. */
  resolvedCount: number;
  /** `upheld` disputes against this solver's resolutions — a highlighted SUBSET
   * of `resolvedCount`, not an additive tally. */
  upheldCount: number;
  /** `reverted` disputes against this solver — the negative reliability signal. */
  revertedCount: number;
  /** Public donation channels (D3). Empty when the solver published none → the
   * "Apóyalo" block renders nothing. */
  donationChannels: DonationChannel[];
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
  resolved_count: number;
  upheld_count: number;
  reverted_count: number;
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

/** Row shape from the public `solver_donation_channels` select. */
type DonationChannelRow = {
  type: DonationType;
  value: string;
  account_kind: AccountKind | null;
  qr_path: string | null;
};

/**
 * Derive the PUBLIC display URL of an uploaded rail QR from its stored
 * `qr_path`. The upload route stores `qr_path = "donation-qr/<uid>/<type>.png"`
 * — i.e. WITH the bucket prefix — so we strip the leading `donation-qr/` and ask
 * the storage SDK for the public URL of the remaining object key. PayPal never
 * has a `qr_path` (its QR is generated), and a rail with no uploaded image keeps
 * `qrUrl = null`.
 */
function donationQrUrl(
  client: SupabaseClient,
  type: DonationType,
  qrPath: string | null,
): string | null {
  // PayPal QRs are generated in the block, never uploaded → never a stored path.
  if (type === "paypal") return null;
  if (!qrPath) return null;

  // Require the EXACT bucket prefix the upload route writes. A path without it is
  // legacy/garbage → no QR, never a mis-scoped or broken public URL.
  const prefix = `${DONATION_QR_BUCKET}/`;
  if (!qrPath.startsWith(prefix)) return null;
  const key = qrPath.slice(prefix.length);
  if (key.length === 0) return null;

  const { data } = client.storage.from(DONATION_QR_BUCKET).getPublicUrl(key);
  return data?.publicUrl ?? null;
}

/**
 * Map a raw channel row to the public `DonationChannel` shape, or `null` to DROP
 * it. A `paypal` row whose value is not a clean `https://paypal.me/<user>` URL is
 * dropped (see `PAYPAL_PUBLIC_URL_RE`) so it never reaches the block's SVG path.
 */
function mapDonationChannel(
  client: SupabaseClient,
  row: DonationChannelRow,
): DonationChannel | null {
  if (row.type === "paypal" && !PAYPAL_PUBLIC_URL_RE.test(row.value)) {
    return null;
  }
  return {
    type: row.type,
    value: row.value,
    accountKind: row.account_kind,
    qrUrl: donationQrUrl(client, row.type, row.qr_path),
  };
}

/**
 * Read a solver's donation channels (the public `solver_donation_channels`
 * select), mapped to the `DonationChannel` shape. Ordered deterministically by
 * `type` so the public block renders consistently. A read error degrades to `[]`
 * (the block simply does not render) — donation channels are never load-bearing
 * for the profile to exist.
 */
async function loadDonationChannels(
  client: SupabaseClient,
  solverId: string,
): Promise<DonationChannel[]> {
  const { data, error } = await client
    .from("solver_donation_channels")
    .select("type, value, account_kind, qr_path")
    .eq("solver_id", solverId)
    .order("type", { ascending: true })
    .returns<DonationChannelRow[]>();

  if (error || !data) return [];
  return data
    .map((row) => mapDonationChannel(client, row))
    .filter((channel): channel is DonationChannel => channel !== null);
}

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
    .select(
      "id, handle, type, bio, avatar_url, links, resolved_count, upheld_count, reverted_count",
    )
    // Case-insensitive (ilike) + injection-safe (metachars escaped → literal
    // match). The DB's lower(handle) unique index guarantees at most one row.
    .ilike("handle", escapeIlike(trimmed))
    .maybeSingle<SolverProfileRow>();

  if (error) {
    throw new Error(`solver profile lookup failed: ${error.message}`);
  }
  if (!data) return null;

  const donationChannels = await loadDonationChannels(client, data.id);

  return {
    id: data.id,
    handle: data.handle,
    type: data.type,
    typeLabel: SOLVER_TYPE_LABELS[data.type] ?? data.type,
    bio: data.bio,
    avatarUrl: data.avatar_url,
    links: data.links ?? {},
    resolvedCount: data.resolved_count,
    upheldCount: data.upheld_count,
    revertedCount: data.reverted_count,
    donationChannels,
  };
}

/**
 * The owner-scoped read for the self-management page (`/mi-perfil/donaciones`):
 * given the signed-in user's id, return their own donation channels (same shape
 * + qrUrl derivation as the public block) so the editor can pre-fill each row.
 * A user with no channels gets `[]`.
 *
 * This reads by `auth.uid()` (passed as `userId`) — there is no handle in the
 * URL, so a user can only ever load THEIR OWN channels (SCEN-011). Uses the
 * service-role admin client by default (server-only caller); injectable for tests.
 */
export async function getOwnDonationChannels(
  userId: string,
  client: SupabaseClient = createAdminSupabase(),
): Promise<DonationChannel[]> {
  const trimmed = userId?.trim() ?? "";
  if (trimmed.length === 0) return [];
  return loadDonationChannels(client, trimmed);
}

/**
 * Whether the given user is a PUBLISHED solver (has a `solver_profiles` row).
 * The management page uses this to decide between the editor and the friendly
 * "this section is for solvers" empty state — a non-solver authenticated user
 * has no solver profile, so they see no editable channels (SCEN-011).
 *
 * Injectable client; defaults to the service-role admin client (server-only).
 */
export async function isPublishedSolver(
  userId: string,
  client: SupabaseClient = createAdminSupabase(),
): Promise<boolean> {
  const trimmed = userId?.trim() ?? "";
  if (trimmed.length === 0) return false;

  const { data, error } = await client
    .from("solver_profiles")
    .select("id")
    .eq("id", trimmed)
    .maybeSingle<{ id: string }>();

  if (error) return false;
  return data != null;
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
