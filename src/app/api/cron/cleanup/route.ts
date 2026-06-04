import { cleanupOrphans } from "@/lib/services/cleanupService";

/**
 * GET /api/cron/cleanup — the daily orphan-cleanup cron (step10).
 *
 * Declared in `vercel.json` (`0 3 * * *`). Vercel invokes it with
 * `Authorization: Bearer <CRON_SECRET>` when the `CRON_SECRET` env var is set.
 * The handler verifies that header and refuses anything else (SCEN-005): no
 * secret configured OR a mismatched header -> 401, and the cleanup service is
 * NEVER invoked on an unauthenticated request.
 *
 * Runs on the Node.js runtime: the sweep uses the service-role supabase-js
 * client, which is not Edge-compatible. The runtime is pinned explicitly (do NOT
 * change to "edge"), and maxDuration caps the function so a large backlog fails
 * fast rather than running unbounded — the sweep is bounded per run (batchLimit)
 * and drains over successive daily runs.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await cleanupOrphans();
    return Response.json(
      {
        deleted: result.deletedReportIds.length,
        // > 0 means a row was reclaimed but its Storage objects may have leaked;
        // monitoring alerts on this.
        storageResidue: result.storageResidueReportIds.length,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("GET /api/cron/cleanup failed", { error });
    return Response.json(
      { error: { code: "internal_error", message: "Cleanup failed." } },
      { status: 500 },
    );
  }
}
