import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A tiny (640-byte) committed JPEG that genuinely embeds a GPS EXIF IFD
 * (Bogotá: 4.6097 N, 74.0817 W). Built once with `piexifjs` and stored as
 * base64 because sharp's `withExif({ GPS: ... })` silently drops the GPS IFD
 * (exif-reader cannot read it back), which would make any "EXIF was stripped"
 * assertion vacuous. The fixture is the ground truth for the strip tests: each
 * test first asserts this buffer HAS GPS via exif-reader, then asserts the
 * processed output does not.
 */
const jpegB64Path = fileURLToPath(
  new URL("./gps-image.jpg.b64", import.meta.url),
);

/**
 * A tiny (468-byte) committed WebP that genuinely embeds the same GPS EXIF as
 * the JPEG fixture (re-encoded with `.keepExif()`). Used by SCEN-H03 to prove
 * the processor preserves the INPUT format — a webp raw stays webp after the
 * strip, never re-encoded as JPEG under a `.webp` path.
 */
const webpB64Path = fileURLToPath(
  new URL("./gps-image.webp.b64", import.meta.url),
);

/** Returns a fresh Buffer of the GPS-bearing JPEG fixture. */
export function gpsJpegFixture(): Buffer {
  return Buffer.from(readFileSync(jpegB64Path, "utf8"), "base64");
}

/** Returns a fresh Buffer of the GPS-bearing WebP fixture. */
export function gpsWebpFixture(): Buffer {
  return Buffer.from(readFileSync(webpB64Path, "utf8"), "base64");
}
