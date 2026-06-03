import sharp from "sharp";

/**
 * Image-processing primitives for the media pipeline (step07).
 *
 * The privacy contract: a citizen's photo may embed GPS EXIF that pinpoints
 * their home. `sharp(buf).toBuffer()` drops ALL metadata by default (we never
 * call `.keepExif()` / `.withMetadata()`), so EXIF — including the GPS IFD — is
 * removed automatically. `.autoOrient()` bakes the EXIF Orientation rotation
 * into the pixels and removes that tag, so the stripped output still displays
 * the right way up.
 *
 * Runs on the Node.js runtime only (sharp ships a native binary; it is not
 * Edge-compatible).
 */

// Serverless memory hygiene: a single concurrent libvips op and no cross-request
// pixel cache keeps the function's RSS bounded under bursty traffic.
sharp.concurrency(1);
sharp.cache(false);

/**
 * Decode guard against decompression bombs (~50 MP — comfortably above any
 * phone photo). sharp throws `Input image exceeds pixel limit` BEFORE allocating
 * the full bitmap, so a malicious image never reaches the heap. The caller maps
 * that throw to a terminal processing failure.
 */
const MAX_PIXELS = 50_000_000;

/** JPEG/WebP quality for the processed full-size image. */
const FULL_QUALITY = 82;
/** PNG compression level for the processed full-size image. */
const PNG_COMPRESSION = 9;
/** WebP quality for the thumbnail. */
const THUMB_QUALITY = 70;
/** Largest thumbnail dimension in pixels. */
const THUMB_MAX = 400;
/** Largest full-size dimension in pixels (FIX C — cap the processed image). */
const FULL_MAX = 2048;

/** Image formats step05 accepts and this processor knows how to re-encode. */
type SupportedFormat = "jpeg" | "png" | "webp";

const CONTENT_TYPE: Record<SupportedFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export type ProcessedImage = {
  data: Buffer;
  width: number;
  height: number;
};

export type ProcessImageResult = {
  /** Processed full-size image bytes (EXIF-free, dimension-capped). */
  full: Buffer;
  /** WebP thumbnail bytes (EXIF-free, <= 400 px). */
  thumb: Buffer;
  /** POST-resize width of the full image (what to persist). */
  width: number;
  /** POST-resize height of the full image (what to persist). */
  height: number;
  /** Output image format (same as the input). */
  format: SupportedFormat;
  /** Content-type matching `format` (for the storage upload). */
  contentType: string;
};

/**
 * Re-encode a sharp pipeline to `format`, preserving the input format so the
 * stored bytes, the `storage_path` extension and the upload content-type all
 * agree (FIX E — never JPEG bytes under a `.webp`/`.png` path).
 */
function encodeAs(
  pipeline: sharp.Sharp,
  format: SupportedFormat,
): sharp.Sharp {
  switch (format) {
    case "png":
      return pipeline.png({ compressionLevel: PNG_COMPRESSION });
    case "webp":
      return pipeline.webp({ quality: FULL_QUALITY });
    case "jpeg":
    default:
      return pipeline.jpeg({ quality: FULL_QUALITY, mozjpeg: true });
  }
}

/** Map a sharp-reported input format to a supported output format (default jpeg). */
function resolveFormat(input: string | undefined): SupportedFormat {
  if (input === "png" || input === "webp") return input;
  return "jpeg";
}

/**
 * Single-decode pipeline (FIX B): probe the header once, then decode the source
 * ONCE and `clone()` it for the two outputs, which are encoded in parallel. The
 * full image is auto-oriented, dimension-capped (FIX C), EXIF-stripped, and
 * re-encoded PRESERVING the input format (FIX E). The thumbnail is always WebP.
 *
 * Throws when the input is undecodable or exceeds `maxPixels` — the caller maps
 * that to a terminal processing failure.
 */
export async function processImage(
  raw: Buffer,
  opts: { maxPixels?: number } = {},
): Promise<ProcessImageResult> {
  const limitInputPixels = opts.maxPixels ?? MAX_PIXELS;

  // Header-only probe (no full decode) to learn the input format. This also
  // throws on an oversized image before any bitmap is allocated.
  const probe = await sharp(raw, { limitInputPixels }).metadata();
  const format = resolveFormat(probe.format);

  const base = sharp(raw, { limitInputPixels }).autoOrient();

  const [full, thumb] = await Promise.all([
    encodeAs(
      base
        .clone()
        .resize({
          width: FULL_MAX,
          height: FULL_MAX,
          fit: "inside",
          withoutEnlargement: true,
        }),
      format,
    ).toBuffer({ resolveWithObject: true }),
    base
      .clone()
      .resize({
        width: THUMB_MAX,
        height: THUMB_MAX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer(),
  ]);

  return {
    full: full.data,
    thumb,
    width: full.info.width,
    height: full.info.height,
    format,
    contentType: CONTENT_TYPE[format],
  };
}

/**
 * Auto-orient, strip all metadata (EXIF/GPS), and re-encode as compressed JPEG.
 * Returns the processed bytes plus the baked-in dimensions. Throws when the
 * input is not a decodable image (the caller maps that to a 'failed' state).
 *
 * Retained for the unit-level strip proof; the service uses `processImage`.
 */
export async function stripExifCompress(raw: Buffer): Promise<ProcessedImage> {
  const { data, info } = await sharp(raw, { limitInputPixels: MAX_PIXELS })
    .autoOrient()
    .jpeg({ quality: FULL_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}

/**
 * Produce a small WebP thumbnail whose largest dimension is <= `max`. Metadata
 * is dropped by default, so the thumbnail carries no EXIF/GPS either.
 */
export async function makeThumbnail(
  raw: Buffer,
  max: number = THUMB_MAX,
): Promise<Buffer> {
  return sharp(raw, { limitInputPixels: MAX_PIXELS })
    .autoOrient()
    .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

/**
 * Derive the deterministic thumbnail path from a media `storage_path`: strip the
 * final extension (if any) and append `.thumb.webp`. There is no DB column for
 * it — the path is recoverable by convention. Idempotent: re-deriving from an
 * already-derived path yields the same result, and it never equals the input
 * (FIX H — a `.thumb.webp` source collapses to `.thumb.webp`, not itself,
 * because the `.thumb` segment is stripped first).
 *
 * Example: `rep-1/0.jpg` -> `rep-1/0.thumb.webp`.
 */
export function thumbnailPath(storagePath: string): string {
  const slash = storagePath.lastIndexOf("/");
  const dir = slash >= 0 ? storagePath.slice(0, slash + 1) : "";
  let name = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;

  // Strip a trailing extension, then a trailing `.thumb`, so the operation is
  // idempotent AND so a `<x>.thumb.webp` input maps back to `<x>.thumb.webp`
  // (distinct from the original full-size path, which has a real extension).
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  if (name.endsWith(".thumb")) name = name.slice(0, -".thumb".length);

  return `${dir}${name}.thumb.webp`;
}
