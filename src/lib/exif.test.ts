import exifReader from "exif-reader";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  makeThumbnail,
  processImage,
  stripExifCompress,
  thumbnailPath,
} from "./exif";
import { gpsJpegFixture, gpsWebpFixture } from "./__fixtures__/gpsImage";

// Unit-level proof of the privacy-critical primitives (SCEN-001 / SCEN-004).
// The strip assertion is NON-vacuous: each test first proves the input fixture
// genuinely carries GPS EXIF (via exif-reader) before asserting it is gone.

/** Reads the GPS IFD from a JPEG buffer, or null when no GPS is present. */
async function readGps(buf: Buffer): Promise<unknown | null> {
  const meta = await sharp(buf).metadata();
  if (!meta.exif) return null;
  const parsed = exifReader(meta.exif);
  return parsed.GPSInfo ?? null;
}

describe("stripExifCompress", () => {
  it("removes all GPS/localization EXIF while keeping the image decodable (SCEN-001)", async () => {
    const input = gpsJpegFixture();

    // The fixture MUST genuinely contain GPS, else the strip below is vacuous.
    const inputGps = await readGps(input);
    expect(inputGps).not.toBeNull();

    const { data, width, height } = await stripExifCompress(input);

    // Image is intact: still decodable with real dimensions.
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    const meta = await sharp(data).metadata();
    expect(meta.width).toBe(width);
    expect(meta.height).toBe(height);

    // No GPS survives (ideally no EXIF block at all).
    const outputGps = await readGps(data);
    expect(outputGps).toBeNull();
  });
});

describe("makeThumbnail", () => {
  it("produces a valid image whose largest dimension is <= 400 (SCEN-004)", async () => {
    const thumb = await makeThumbnail(gpsJpegFixture());

    const meta = await sharp(thumb).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(400);
  });

  it("strips GPS EXIF from the thumbnail too", async () => {
    const input = gpsJpegFixture();
    expect(await readGps(input)).not.toBeNull();

    const thumb = await makeThumbnail(input);
    expect(await readGps(thumb)).toBeNull();
  });
});

describe("thumbnailPath", () => {
  it("derives a deterministic .thumb.webp path next to the original", () => {
    expect(thumbnailPath("rep-1/0.jpg")).toBe("rep-1/0.thumb.webp");
    expect(thumbnailPath("rep-1/2.png")).toBe("rep-1/2.thumb.webp");
  });

  it("appends the suffix when the path has no extension", () => {
    expect(thumbnailPath("rep-1/0")).toBe("rep-1/0.thumb.webp");
  });

  it("is idempotent: applying it twice does not double the suffix segment", () => {
    const once = thumbnailPath("rep-1/0.jpg");
    expect(thumbnailPath(once)).toBe("rep-1/0.thumb.webp");
  });

  // FIX H: for every real step05 source extension, the derived thumbnail path
  // differs from the source — so writing the thumbnail never overwrites the full
  // image. (A pathological `.thumb.webp` source is caught by the runtime guard
  // in processMedia, since thumbnailPath is idempotent on it — asserted above.)
  it("differs from the source for every real media extension (FIX H)", () => {
    for (const p of ["rep-1/0.jpg", "rep-1/0.webp", "rep-1/0.png", "rep-1/0"]) {
      expect(thumbnailPath(p)).not.toBe(p);
    }
  });
});

describe("processImage (single-decode pipeline)", () => {
  it("strips GPS, caps dimensions, preserves the input format, and returns a thumbnail (FIX B/C/E)", async () => {
    const input = gpsJpegFixture();
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif && exifReader(inMeta.exif).GPSInfo).toBeTruthy();

    const out = await processImage(input);

    // Full image: GPS-free, decodable, format preserved (jpeg in -> jpeg out).
    expect(out.format).toBe("jpeg");
    expect(out.contentType).toBe("image/jpeg");
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
    const fullMeta = await sharp(out.full).metadata();
    expect(fullMeta.format).toBe("jpeg");
    expect(await readGps(out.full)).toBeNull();
    // Reported dims are the POST-resize dims (FIX C).
    expect(fullMeta.width).toBe(out.width);
    expect(fullMeta.height).toBe(out.height);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2048);

    // Thumbnail: webp, <=400, GPS-free.
    const thumbMeta = await sharp(out.thumb).metadata();
    expect(thumbMeta.format).toBe("webp");
    expect(Math.max(thumbMeta.width!, thumbMeta.height!)).toBeLessThanOrEqual(
      400,
    );
    expect(await readGps(out.thumb)).toBeNull();
  });

  it("preserves WebP input as WebP output, not JPEG bytes under a webp path (SCEN-H03)", async () => {
    const input = gpsWebpFixture();
    expect((await sharp(input).metadata()).format).toBe("webp");

    const out = await processImage(input);

    expect(out.format).toBe("webp");
    expect(out.contentType).toBe("image/webp");
    expect((await sharp(out.full).metadata()).format).toBe("webp");
    expect(await readGps(out.full)).toBeNull();
  });

  it("rejects a decompression bomb via limitInputPixels before allocating (SCEN-H01)", async () => {
    // A 1x1 image processed under an absurdly tiny pixel cap stands in for a
    // bomb: the same `Input image exceeds pixel limit` throw path.
    const tiny = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();

    await expect(processImage(tiny, { maxPixels: 1 })).rejects.toThrow(
      /pixel limit/i,
    );
  });
});
