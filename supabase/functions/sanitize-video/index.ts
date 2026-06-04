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
// verify_jwt = true (config.toml): the gateway rejects unauthenticated requests
// (401) before this handler runs. supabase-js functions.invoke() auto-attaches
// the session/anon-key JWT, so the real client needs no extra wiring. Defence in
// depth on top of the unguessable report_id/media_id UUIDs.

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

/** Deterministic "the raw object isn't there yet" — NOT a transient I/O fault.
 * Re-raised by withRetry without burning the backoff budget (SCEN-H01). */
class NotReadyError extends Error {
  constructor(path: string) {
    super(`raw object not found at ${path}`);
    this.name = "NotReadyError";
  }
}

/**
 * True when a Supabase storage download error is a deterministic not-found (the
 * object was never uploaded / wrong path) rather than a transient network/5xx.
 * The storage error carries a numeric `status`/`statusCode` (400/404 for a miss)
 * and/or a "not found"/"Object not found" message; match defensively across the
 * shapes the storage client has used.
 */
function isStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; statusCode?: number | string; message?: string };
  const code = Number(e.status ?? e.statusCode);
  if (code === 404 || code === 400) return true;
  return /not[\s_]?found/i.test(e.message ?? "");
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

  // 5. Download the raw object. Distinguish a DETERMINISTIC not-found (the
  // client invoked before completing the upload, or a wrong path) from TRUE
  // transient I/O. A not-found is NOT-READY (mirrors step07's MediaNotReadyError,
  // SCEN-H01): do NOT retry with backoff, do NOT markFailed (leave 'pending' so a
  // later retry after the upload completes can still process it), return 409.
  // Only genuine transient faults go through withRetry -> 503 after exhaustion.
  // The retried op THROWS a plain Error for transient faults, but for a not-found
  // it throws a `NotReadyError` that withRetry will re-raise unchanged after a
  // single attempt (we never re-enter on it because the first attempt already
  // resolves the deterministic answer).
  let raw: Uint8Array;
  try {
    const blob = await withRetry(
      async () => {
        const { data: dl, error } = await admin.storage
          .from(BUCKET)
          .download(row.storage_path);
        if (error || !dl) {
          if (isStorageNotFound(error)) {
            throw new NotReadyError(row.storage_path);
          }
          throw new Error(`download failed: ${error?.message ?? "no data"}`);
        }
        return dl;
      },
      // A not-found is deterministic — short-circuit, do not back off (SCEN-H01).
      { shouldRetry: (e) => !(e instanceof NotReadyError) },
    );
    raw = new Uint8Array(await blob.arrayBuffer());
  } catch (cause) {
    if (cause instanceof NotReadyError) {
      // Not-ready: leave 'pending', retryable by the client later (SCEN-H01).
      console.warn("sanitize-video: raw object not yet available", {
        id: row.id,
        path: row.storage_path,
      });
      return json({ error: "media_not_ready" }, 409);
    }
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
  // `.select()` returns the AFFECTED rows so we can tell a real transition apart
  // from a 0-row match (a concurrent writer already set 'processed' or 'failed').
  // supabase-js returns error===null on a 0-row update, so without this we would
  // wrongly report 200 on a conflict (FIX C).
  const { data: updated, error: updError } = await admin
    .from("report_media")
    .update({ processing_state: "processed" })
    .eq("id", row.id)
    .eq("processing_state", "pending")
    .select("processing_state");
  if (updError) {
    // The object is already sanitized; a transient DB update failure is
    // retryable by re-invoking (the idempotent short-circuit then heals it).
    console.error("sanitize-video: mark processed failed", {
      id: row.id,
      error: updError.message,
    });
    return json({ error: "state update failed after retries" }, 503);
  }

  if (!updated || updated.length === 0) {
    // 0 rows matched: a concurrent writer changed the state under us. Re-read and
    // reconcile — if it's now 'processed' the outcome we wanted holds (idempotent
    // 200); otherwise surface the conflict (e.g. a concurrent 'failed') as 409.
    const { data: cur } = await admin
      .from("report_media")
      .select("processing_state")
      .eq("id", row.id)
      .maybeSingle();
    if (cur?.processing_state === "processed") {
      return json({ state: "processed", idempotent: true }, 200);
    }
    return json({ state: cur?.processing_state ?? "unknown", conflict: true }, 409);
  }

  return json({ state: "processed", idempotent: false }, 200);
});
