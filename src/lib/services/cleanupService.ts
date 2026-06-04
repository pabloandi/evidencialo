import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Orphan-cleanup service (step10 + hardening) — the daily sweep behind
 * GET /api/cron/cleanup.
 *
 * A report is born `is_visible=false` while its media uploads. If the client
 * never finishes (or never started) the upload, the row + any partial Storage
 * objects linger. This service deletes reports that are STILL invisible AND
 * older than the cutoff AND are either waiting on a `pending` upload OR have no
 * media at all (an abandoned creation), together with their Storage objects. The
 * `reports` delete cascades to `report_media` (FK ON DELETE CASCADE), so only
 * the parent row and the Storage objects need explicit work.
 *
 * Decisions:
 *  - SCEN-004: a report whose only media is `failed` is KEPT — processing
 *    happened and the panel reviews it; it is not an abandoned upload.
 *  - SCEN-H02: a report with ZERO media rows IS swept — an abandoned creation.
 *
 * Selection runs SERVER-SIDE in the `find_orphan_reports` SQL RPC (migration
 * 0008): bounded by `batchLimit` and ordered OLDEST-first, so repeated cron runs
 * drain a backlog deterministically and never starve the tail (SCEN-H01). This
 * replaces the original no-LIMIT/no-order two-query sweep, which silently capped
 * at PostgREST's 1000-row max and could exceed the function's maxDuration.
 *
 * The clock (`now`), the cutoff window (`cutoffHours`, default 24) and the
 * per-run cap (`batchLimit`, default 200) are INJECTABLE so tests pin
 * deterministic behavior. Writes go through the SERVICE-ROLE admin client (RLS
 * bypassed); the client is injectable for tests.
 */

const BUCKET = "report-media";
const DEFAULT_CUTOFF_HOURS = 24;
const DEFAULT_BATCH_LIMIT = 200;
/** Storage `list` page size (the bucket default is also 100). */
const STORAGE_PAGE_SIZE = 100;
/** Max paths per `remove()` call so a huge object set is chunked. */
const STORAGE_REMOVE_CHUNK = 1000;

export type CleanupOptions = {
  /** Run clock; defaults to `new Date()`. Injectable for a fixed test clock. */
  now?: Date;
  /** Age threshold in hours; a report must be older than this to be swept. */
  cutoffHours?: number;
  /** Max reports reclaimed per run (the RPC's `p_limit`). */
  batchLimit?: number;
};

export type CleanupResult = {
  /** Reports whose rows were deleted this run. */
  deletedReportIds: string[];
  /**
   * Reports whose ROW was deleted but whose Storage removal errored — the
   * objects may have leaked. Surfaced so monitoring can alert when > 0.
   */
  storageResidueReportIds: string[];
};

/** Split an array into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Remove ALL Storage objects under a report's prefix. Paginates `list()` (its
 * default page is 100, so a report with >100 objects would otherwise leak the
 * rest — FIX B) and chunks `remove()`. Defensive: any list/remove error is
 * logged and reported back as residue rather than thrown, so one bad report
 * never aborts the sweep. Returns `true` when removal was clean, `false` when
 * any object may remain.
 */
async function removeStorageObjects(
  client: SupabaseClient,
  reportId: string,
): Promise<boolean> {
  const names: string[] = [];
  let offset = 0;

  // Accumulate every page of object names under the prefix.
  for (;;) {
    const { data, error } = await client.storage
      .from(BUCKET)
      .list(reportId, { limit: STORAGE_PAGE_SIZE, offset });
    if (error) {
      console.error("cleanupOrphans: storage list failed; residue possible", {
        reportId,
        offset,
        error,
      });
      return false;
    }
    if (!data || data.length === 0) break;
    for (const obj of data) names.push(`${reportId}/${obj.name}`);
    if (data.length < STORAGE_PAGE_SIZE) break; // last (partial) page
    offset += STORAGE_PAGE_SIZE;
  }

  if (names.length === 0) return true;

  let clean = true;
  for (const batch of chunk(names, STORAGE_REMOVE_CHUNK)) {
    const { error } = await client.storage.from(BUCKET).remove(batch);
    if (error) {
      console.error("cleanupOrphans: storage remove failed; residue", {
        reportId,
        count: batch.length,
        error,
      });
      clean = false;
    }
  }
  return clean;
}

export async function cleanupOrphans(
  opts: CleanupOptions = {},
  client: SupabaseClient = createAdminSupabase(),
): Promise<CleanupResult> {
  const now = opts.now ?? new Date();
  const cutoffHours = opts.cutoffHours ?? DEFAULT_CUTOFF_HOURS;
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const cutoff = new Date(
    now.getTime() - cutoffHours * 3600_000,
  ).toISOString();

  // 1. Bounded, oldest-first orphan ids from the server-side RPC. This caps the
  //    work per run and guarantees forward progress on a backlog (SCEN-H01). The
  //    SQL filters age/visibility AND the pending-OR-zero-media predicate, so a
  //    failed-only report is excluded here (SCEN-004) and a zero-media report is
  //    included (SCEN-H02).
  const { data: orphans, error: orphanError } = await client.rpc(
    "find_orphan_reports",
    { p_cutoff: cutoff, p_limit: batchLimit },
  );
  if (orphanError) {
    throw new Error(
      `cleanupOrphans: find_orphan_reports RPC failed: ${orphanError.message}`,
    );
  }

  // `setof uuid` comes back as rows of `{ id }` (PostgREST names the scalar
  // column after the function). Be tolerant of a bare-string row shape too.
  const orphanIds: string[] = (orphans ?? []).map(
    (row: { id?: string } | string) =>
      typeof row === "string" ? row : (row.id as string),
  );

  if (orphanIds.length === 0) {
    return { deletedReportIds: [], storageResidueReportIds: [] };
  }

  // 2. Remove each orphan's Storage objects BEFORE the row delete (the cascade
  //    drops report_media, but the objects are keyed by the report-id prefix, so
  //    listing does not depend on the rows). Bounded concurrency: one removal
  //    per orphan in parallel — removeStorageObjects swallows per-report errors
  //    and reports residue, so Promise.all never rejects.
  const residue = await Promise.all(
    orphanIds.map(async (id) => ({
      id,
      clean: await removeStorageObjects(client, id),
    })),
  );
  const storageResidueReportIds = residue
    .filter((r) => !r.clean)
    .map((r) => r.id);

  // 3. ONE batched delete for the whole run (cascade removes report_media).
  const { error: deleteError } = await client
    .from("reports")
    .delete()
    .in("id", orphanIds);
  if (deleteError) {
    throw new Error(
      `cleanupOrphans: batched report delete failed: ${deleteError.message}`,
    );
  }

  return { deletedReportIds: orphanIds, storageResidueReportIds };
}
