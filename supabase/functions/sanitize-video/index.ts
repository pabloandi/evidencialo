// sanitize-video — Supabase Edge Function (Deno, service-role).
//
// The client uploads the RAW mp4 straight to the PRIVATE `report-media` bucket
// via the step05 signed URL, then invokes this function with { report_id,
// media_id }. We download the raw object, strip container-level location/GPS PII
// (moov/udta, moov/meta) WITHOUT transcoding (ffmpeg is unavailable here — see
// mp4.ts for the size-preserving retype-to-`free` technique), OVERWRITE the
// object, and mark report_media.processing_state. The step08 trigger
// (refresh_report_visibility) flips reports.is_visible once no media is
// pending/failed.
//
// Failure taxonomy mirrors step07 (mediaService.ts):
//   - mp4 parse/strip throw  -> TERMINAL 'failed' (corrupt container, not
//                               retried); respond 422.
//   - transient download/upload I/O -> retried with backoff (withRetry); only
//                               'failed' after exhausting the budget; respond 503.
//   - row missing / report mismatch -> 404 (state untouched).
//   - non-video media        -> 422 (wrong processor).
//   - already 'processed'     -> 200 idempotent, no re-download (SCEN-004).
//
// verify_jwt = false: this is an internal processor keyed by unguessable UUIDs,
// the same open posture as /api/media (documented in config.toml).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

import { stripMp4Metadata } from "./mp4.ts";
import { withRetry } from "./retry.ts";

const BUCKET = "report-media";

// Server-side cap mirroring the client-side video ceiling; an oversized raw is a
// TERMINAL failure (treated like a corrupt container) before we attempt to parse.
const MAX_RAW_BYTES = 50_000_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MediaRow = {
  id: string;
  report_id: string;
  storage_path: string;
  type: "image" | "video";
  processing_state: "pending" | "processed" | "failed";
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Best-effort flip to 'failed'. supabase-js resolves { error } (never throws),
 * so inspect the returned error rather than rely on try/catch. */
async function markFailed(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin
    .from("report_media")
    .update({ processing_state: "failed" })
    .eq("id", id);
  if (error) {
    console.error("sanitize-video: failed to mark media 'failed'", {
      id,
      error: error.message,
    });
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // 1. Parse + validate the body. Bad UUIDs -> 400.
  let body: { report_id?: unknown; media_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const reportId = body.report_id;
  const mediaId = body.media_id;
  if (
    typeof reportId !== "string" ||
    typeof mediaId !== "string" ||
    !UUID_RE.test(reportId) ||
    !UUID_RE.test(mediaId)
  ) {
    return json({ error: "report_id and media_id must be UUIDs" }, 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 2. Fetch the row. Missing OR belonging to another report -> 404.
  const { data, error: lookupError } = await admin
    .from("report_media")
    .select("id, report_id, storage_path, type, processing_state")
    .eq("id", mediaId)
    .maybeSingle();

  if (lookupError) {
    console.error("sanitize-video: lookup failed", { error: lookupError.message });
    return json({ error: "lookup failed" }, 500);
  }
  const row = data as MediaRow | null;
  if (!row || row.report_id !== reportId) {
    return json({ error: "media not found or report mismatch" }, 404);
  }

  // 3. Only videos here.
  if (row.type !== "video") {
    return json({ error: `unsupported media type: ${row.type}` }, 422);
  }

  // 4. Idempotent short-circuit (SCEN-004): already processed -> 200, no
  // re-download, no duplicate work.
  if (row.processing_state === "processed") {
    return json({ state: "processed", idempotent: true }, 200);
  }

  // 5. Download the raw object (transient I/O -> retried).
  let raw: Uint8Array;
  try {
    const blob = await withRetry(async () => {
      const { data: dl, error } = await admin.storage
        .from(BUCKET)
        .download(row.storage_path);
      if (error || !dl) {
        throw new Error(`download failed: ${error?.message ?? "no data"}`);
      }
      return dl;
    });
    raw = new Uint8Array(await blob.arrayBuffer());
  } catch (cause) {
    // Exhausted transient I/O budget -> 'failed' (SCEN-005), respond 503.
    await markFailed(admin, row.id);
    console.error("sanitize-video: download exhausted retries", {
      id: row.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return json({ error: "download failed after retries" }, 503);
  }

  // 5a. Oversized raw is a TERMINAL failure.
  if (raw.byteLength > MAX_RAW_BYTES) {
    await markFailed(admin, row.id);
    return json({ error: "raw video exceeds size limit" }, 422);
  }

  // 6. Strip container metadata. A parse/strip THROW is TERMINAL (corrupt
  // container) — mark 'failed', do NOT retry (SCEN-002), respond 422.
  let processed: Uint8Array;
  try {
    processed = stripMp4Metadata(raw);
  } catch (cause) {
    await markFailed(admin, row.id);
    console.error("sanitize-video: mp4 strip failed (terminal)", {
      id: row.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return json({ error: "video could not be sanitized" }, 422);
  }

  // 7. Overwrite the stored object (transient I/O -> retried).
  try {
    await withRetry(async () => {
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(row.storage_path, processed, {
          upsert: true,
          contentType: "video/mp4",
        });
      if (error) throw new Error(`upload failed: ${error.message}`);
    });
  } catch (cause) {
    await markFailed(admin, row.id);
    console.error("sanitize-video: upload exhausted retries", {
      id: row.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return json({ error: "upload failed after retries" }, 503);
  }

  // 8. Mark processed. Guard with the pending filter so a concurrent second
  // writer is a harmless no-op; the step08 trigger then recomputes is_visible.
  const { error: updError } = await admin
    .from("report_media")
    .update({ processing_state: "processed" })
    .eq("id", row.id)
    .eq("processing_state", "pending");
  if (updError) {
    // The object is already sanitized; a transient DB update failure is
    // retryable by re-invoking (the idempotent short-circuit then heals it).
    console.error("sanitize-video: mark processed failed", {
      id: row.id,
      error: updError.message,
    });
    return json({ error: "state update failed after retries" }, 503);
  }

  return json({ state: "processed", idempotent: false }, 200);
});
