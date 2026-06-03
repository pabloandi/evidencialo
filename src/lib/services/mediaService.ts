import type { SupabaseClient } from "@supabase/supabase-js";

import { processImage, thumbnailPath } from "@/lib/exif";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Server-side media processor (step07) — the PROCESSOR, not a bytes-receiver.
 *
 * The client has already uploaded the RAW image to the PRIVATE `report-media`
 * bucket via a signed upload URL (step05). This service downloads that raw
 * object, strips all EXIF (incl. GPS PII), auto-orients, compresses, OVERWRITES
 * `storage_path` with the EXIF-free image, writes a derived-path thumbnail, and
 * marks `report_media.processing_state`. Privacy holds because the bucket is
 * private and `reports.is_visible` stays false until the step08 trigger flips it
 * once all media is processed; the raw-with-EXIF is overwritten on success.
 *
 * Failure taxonomy (FIX D) distinguishes TERMINAL from RETRYABLE faults:
 *   - decode/bomb/oversized  -> terminal 'failed'  (MediaProcessingError, 422)
 *   - object never uploaded  -> stays 'pending'     (MediaNotReadyError, 409)
 *   - transient write/upload -> stays 'pending'     (MediaWriteError, 503)
 * Re-processing is safe: uploads are upsert and an already-overwritten image is
 * still EXIF-free, so a retryable error never leaks PII.
 *
 * Runs through the SERVICE-ROLE admin client (RLS bypassed). The client is
 * injectable for testing. Node.js runtime only (sharp needs a native binary).
 */

const BUCKET = "report-media";

/** Server-side guard: raw objects above this byte size are rejected pre-decode.
 * Mirrors the 10 MB image cap that step05 enforces only client-side. */
const MAX_RAW_BYTES = 10_000_000;

/** Row not found, or it does not belong to the given report. Route -> 404. */
export class MediaNotFoundError extends Error {
  constructor(public readonly mediaId: string) {
    super(`report_media not found or report mismatch: ${mediaId}`);
    this.name = "MediaNotFoundError";
  }
}

/** Non-image media reached the image processor. Route -> 422. */
export class UnsupportedMediaError extends Error {
  constructor(public readonly type: string) {
    super(`Unsupported media type for image processing: ${type}`);
    this.name = "UnsupportedMediaError";
  }
}

/**
 * TERMINAL decode failure: the raw object is undecodable, oversized, or a
 * decompression bomb. The row is marked 'failed'. Route -> 422.
 */
export class MediaProcessingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "MediaProcessingError";
  }
}

/**
 * RETRYABLE not-ready: the raw object does not exist at `storage_path` (the
 * client abandoned the signed upload). The row stays 'pending' so a later retry
 * after the upload completes can still process it. Route -> 409.
 */
export class MediaNotReadyError extends Error {
  constructor(public readonly mediaId: string) {
    super(`raw object not yet available for media: ${mediaId}`);
    this.name = "MediaNotReadyError";
  }
}

/**
 * RETRYABLE write failure: decode SUCCEEDED but a storage upload or the DB
 * state-update failed transiently. The row stays 'pending' (NOT 'failed'); the
 * upserted uploads make a retry idempotent. Route -> 503.
 */
export class MediaWriteError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "MediaWriteError";
  }
}

export type ProcessMediaInput = {
  reportId: string;
  mediaId: string;
};

export type ProcessMediaResult = {
  state: "processed";
  width: number;
  height: number;
};

type MediaRow = {
  id: string;
  report_id: string;
  storage_path: string;
  type: "image" | "video";
  width: number | null;
  height: number | null;
  processing_state: "pending" | "processed" | "failed";
};

export async function processMedia(
  input: ProcessMediaInput,
  client: SupabaseClient = createAdminSupabase(),
): Promise<ProcessMediaResult> {
  // 1. Fetch the row. Missing OR belonging to another report -> not found.
  const { data, error } = await client
    .from("report_media")
    .select("id, report_id, storage_path, type, width, height, processing_state")
    .eq("id", input.mediaId)
    .maybeSingle();

  if (error) {
    throw new Error(`report_media lookup failed: ${error.message}`);
  }
  const row = data as MediaRow | null;
  if (!row || row.report_id !== input.reportId) {
    throw new MediaNotFoundError(input.mediaId);
  }

  // 2. Only images are processed here; video is handled elsewhere.
  if (row.type !== "image") {
    throw new UnsupportedMediaError(row.type);
  }

  // 3. Idempotent short-circuit: already processed -> return stored dims, do not
  // re-download or re-process (SCEN-003).
  if (row.processing_state === "processed") {
    return {
      state: "processed",
      width: row.width ?? 0,
      height: row.height ?? 0,
    };
  }

  // 4. Download the raw object. A missing object means the client abandoned the
  // upload — NOT-READY, retryable, row stays 'pending' (SCEN-H04). Do NOT
  // markFailed here.
  const { data: blob, error: dlError } = await client.storage
    .from(BUCKET)
    .download(row.storage_path);
  if (dlError || !blob) {
    throw new MediaNotReadyError(input.mediaId);
  }
  const raw = Buffer.from(await blob.arrayBuffer());

  // 5a. Server-side byte recheck (FIX A): the 10 MB cap previously lived only
  // client-side. An oversized raw is a TERMINAL processing failure (treated like
  // a bomb) — flip to 'failed' and stop before decoding (SCEN-H01).
  if (raw.byteLength > MAX_RAW_BYTES) {
    await markFailed(client, row.id);
    throw new MediaProcessingError(
      `raw object ${row.storage_path} exceeds ${MAX_RAW_BYTES} bytes (${raw.byteLength})`,
    );
  }

  // 5b. DECODE + thumbnail in a SINGLE pipeline. Any decode/bomb/processing
  // throw is TERMINAL -> 'failed' (SCEN-007, SCEN-H01).
  let processed: Awaited<ReturnType<typeof processImage>>;
  try {
    processed = await processImage(raw);
  } catch (cause) {
    await markFailed(client, row.id);
    throw new MediaProcessingError(
      `failed to decode/process media ${row.id}: ${asMessage(cause)}`,
      cause,
    );
  }

  const thumbPath = thumbnailPath(row.storage_path);
  // FIX H: a derived thumbnail path that collides with the source would
  // overwrite the full image with the thumbnail. Treat as terminal (the source
  // path is malformed), never silently corrupt the object.
  if (thumbPath === row.storage_path) {
    await markFailed(client, row.id);
    throw new MediaProcessingError(
      `thumbnail path collides with source path: ${row.storage_path}`,
    );
  }

  // 5c. WRITES (uploads + DB update). A failure here is RETRYABLE: the decode
  // already succeeded, the uploads are upsert, so the row stays 'pending' and a
  // retry heals it (SCEN-H02). Do NOT markFailed. Uploads run in parallel
  // (independent paths, FIX B).
  try {
    const [up1, up2] = await Promise.all([
      client.storage.from(BUCKET).upload(row.storage_path, processed.full, {
        upsert: true,
        contentType: processed.contentType,
      }),
      client.storage.from(BUCKET).upload(thumbPath, processed.thumb, {
        upsert: true,
        contentType: "image/webp",
      }),
    ]);
    if (up1.error) {
      throw new Error(`upload processed image failed: ${up1.error.message}`);
    }
    if (up2.error) {
      throw new Error(`upload thumbnail failed: ${up2.error.message}`);
    }

    // Guard the final update with the pending-state filter so a late concurrent
    // second writer is a harmless no-op. NOTE: this is a PARTIAL concurrency
    // mitigation — two writers can still both do the (idempotent) image work
    // before either updates; a full claim needs a 'processing' enum value,
    // DEFERRED to step08. The residual double-work is accepted for the MVP.
    const upd = await client
      .from("report_media")
      .update({
        processing_state: "processed",
        width: processed.width,
        height: processed.height,
      })
      .eq("id", row.id)
      .eq("processing_state", "pending");
    if (upd.error) {
      throw new Error(`mark processed failed: ${upd.error.message}`);
    }
  } catch (cause) {
    // Transient write fault -> leave 'pending' (retryable), do NOT markFailed.
    throw new MediaWriteError(
      `transient write failure for media ${row.id}: ${asMessage(cause)}`,
      cause,
    );
  }

  return {
    state: "processed",
    width: processed.width,
    height: processed.height,
  };
}

function asMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Best-effort flip to 'failed' for TERMINAL faults only. supabase-js
 * `.update().eq()` RESOLVES `{ error }` and does NOT throw (FIX F), so we must
 * inspect the returned error rather than rely on try/catch.
 */
async function markFailed(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client
    .from("report_media")
    .update({ processing_state: "failed" })
    .eq("id", id);
  if (error) {
    console.error("failed to mark report_media as failed", {
      id,
      error: error.message,
    });
  }
}
