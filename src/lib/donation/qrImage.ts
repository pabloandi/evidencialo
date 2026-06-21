import sharp from "sharp";

/**
 * QR-safe image sanitizer for uploaded donation QRs (subsystem D, chunk D2;
 * SCEN-007).
 *
 * DISTINCT from the photo pipeline (`src/lib/exif.ts` `processImage`): that path
 * down-resizes to 2048 and applies LOSSY webp/jpeg (mozjpeg q82), which can
 * introduce edge artifacts that break QR scannability — a silent donation
 * failure. This sanitizer instead:
 *   - reuses sharp's metadata-stripping DEFAULT (we never call `.withMetadata()`
 *     / `.keepExif()`), so EXIF — including any GPS IFD — is removed,
 *   - reuses the `MAX_PIXELS` decompression-bomb guard (header-probed BEFORE the
 *     bitmap is allocated),
 *   - caps the largest side at 1024px (`fit: 'inside', withoutEnlargement: true`
 *     → a cap only: never upscales a small QR, never down-resizes below a
 *     scannable density),
 *   - encodes LOSSLESS PNG (`compressionLevel: 9`) so the modules stay crisp and
 *     the stored bytes match the `.png` storage path / content-type,
 *   - rejects a non-decodable / non-image input (the caller maps that to a 422).
 *
 * Node.js runtime only (sharp ships a native binary; not Edge-compatible).
 */

// Single concurrent libvips op + no cross-request cache: bounded RSS under
// bursty uploads (same hygiene as the photo pipeline).
sharp.concurrency(1);
sharp.cache(false);

/**
 * Decompression-bomb guard (~50 MP, comfortably above any phone-exported QR).
 * sharp throws "Input image exceeds pixel limit" at the header probe, BEFORE
 * allocating the full bitmap, so a malicious image never reaches the heap.
 */
const MAX_PIXELS = 50_000_000;

/** Upper cap on the largest side — a cap only, never an upscale floor. */
const MAX_SIDE = 1024;

/** PNG compression level (max; lossless). */
const PNG_COMPRESSION = 9;

/** Image input formats a phone exports a QR as; anything else is rejected. */
const ACCEPTED_FORMATS: ReadonlySet<string> = new Set([
  "png",
  "jpeg",
  "webp",
  "gif",
  "tiff",
  "avif",
]);

export class InvalidQrImageError extends Error {
  constructor(message = "uploaded file is not a decodable image") {
    super(message);
    this.name = "InvalidQrImageError";
  }
}

export type SanitizedQrImage = {
  /** Lossless PNG bytes, metadata stripped. */
  data: Buffer;
  /** Always PNG (matches the `.png` storage path). */
  contentType: "image/png";
  /** Output width after the (cap-only) resize. */
  width: number;
  /** Output height after the (cap-only) resize. */
  height: number;
};

/**
 * Sanitize an uploaded QR image to a metadata-free, lossless PNG capped at
 * 1024px on its largest side. Throws `InvalidQrImageError` when the input is
 * not a decodable raster image (or exceeds the pixel-bomb guard).
 */
export async function sanitizeQrImage(buf: Buffer): Promise<SanitizedQrImage> {
  if (!buf || buf.length === 0) {
    throw new InvalidQrImageError("empty upload");
  }

  // Header-only probe: learns the format AND throws on an oversized image
  // before any bitmap is allocated. A non-image (or truncated) input throws
  // here too — normalize every failure to InvalidQrImageError.
  let format: string | undefined;
  try {
    const meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
    format = meta.format;
  } catch (error) {
    throw new InvalidQrImageError(
      error instanceof Error ? error.message : "undecodable image",
    );
  }

  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw new InvalidQrImageError(`unsupported image format: ${format ?? "?"}`);
  }

  try {
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_PIXELS })
      // Bake EXIF Orientation into pixels then drop the tag (a sideways QR still
      // scans). Metadata is stripped by default (no .withMetadata()).
      .autoOrient()
      // Cap only: never enlarges a small QR, never resizes below scannable.
      .resize(MAX_SIDE, MAX_SIDE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      // Lossless: QR modules must stay crisp; no webp/jpeg artifacting.
      .png({ compressionLevel: PNG_COMPRESSION })
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      contentType: "image/png",
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    throw new InvalidQrImageError(
      error instanceof Error ? error.message : "re-encode failed",
    );
  }
}
