/**
 * Shared signed-upload mechanics (chunk B2.3).
 *
 * Extracts the EXACT browser-side upload steps the citizen capture flow uses
 * (`CaptureForm.tsx`) so the solver proof-upload flow (`ResolutionUpload.tsx`)
 * reuses them verbatim instead of re-implementing a second, drifting copy:
 *   1. PUT the raw bytes to the signed upload URL via the browser Supabase
 *      client (`uploadToSignedUrl(path, token, file)`).
 *   2. For an IMAGE, `POST /api/media { report_id, media_id }` to strip EXIF and
 *      mark the object `processed` (video is sanitized async, so it is skipped
 *      here and stays pending briefly).
 *
 * These functions are framework-free and side-effect-local: the browser client
 * is injected so they are trivial to unit test, and `CaptureForm` keeps its own
 * inline copy unchanged (behavior identical) — this module is purely additive.
 */

const STORAGE_BUCKET = "report-media";

/** The signed-upload descriptor both media routes return per object. */
export type SignedUpload = {
  signedUrl: string;
  token: string;
  path: string;
};

/** Minimal shape of the browser Supabase client the upload needs. */
export type UploadClient = {
  storage: {
    from: (bucket: string) => {
      uploadToSignedUrl: (
        path: string,
        token: string,
        file: File,
      ) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/**
 * PUT the raw bytes of `file` to its signed upload URL. Mirrors CaptureForm's
 * call exactly (same bucket, same `uploadToSignedUrl(path, token, file)`
 * signature). Throws a Spanish-message Error on failure so the caller surfaces
 * it inline.
 */
export async function uploadBytesToSignedUrl(
  client: UploadClient,
  upload: SignedUpload,
  file: File,
): Promise<void> {
  const { error } = await client.storage
    .from(STORAGE_BUCKET)
    .uploadToSignedUrl(upload.path, upload.token, file);
  if (error) {
    throw new Error("No se pudo subir el archivo. Inténtalo de nuevo.");
  }
}

/**
 * Trigger EXIF-strip + processing for an uploaded IMAGE object (same call
 * CaptureForm makes). Videos are sanitized by the async pipeline, so the caller
 * must NOT invoke this for `type === "video"`. Throws on a non-OK response.
 */
export async function processUploadedImage(
  reportId: string,
  mediaId: string,
): Promise<void> {
  const res = await fetch("/api/media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report_id: reportId, media_id: mediaId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      body?.error?.message ??
        "El archivo se subió pero no se pudo procesar. Reintenta.",
    );
  }
}
