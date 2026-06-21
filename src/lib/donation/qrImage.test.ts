import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { InvalidQrImageError, sanitizeQrImage } from "./qrImage";

// Observable contract for the QR-safe sanitizer (D2, SCEN-007): PNG out,
// metadata stripped, a <=1024 QR not downscaled, a non-image rejected, AND the
// load-bearing invariant — a real QR round-tripped through the sanitizer still
// DECODES to its original payload (scannability OBSERVED, not inferred).

const PAYLOAD = "https://paypal.me/johndoe";

/** A known QR PNG at `width`px, carrying EXIF+a text chunk so the strip is non-vacuous. */
async function makeQrPng(width: number): Promise<Buffer> {
  const base = await QRCode.toBuffer(PAYLOAD, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    width,
  });
  // Re-encode WITH metadata so the sanitizer has something real to strip.
  return sharp(base)
    .withMetadata({
      exif: {
        IFD0: { ImageDescription: "secret-camera-make" },
      },
    })
    .png()
    .toBuffer();
}

/** Decode a PNG buffer's QR payload (via raw RGBA + jsQR), or null. */
async function decodeQr(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const res = jsQR(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
  );
  return res ? res.data : null;
}

describe("sanitizeQrImage", () => {
  it("outputs lossless PNG with the image/png content-type", async () => {
    const out = await sanitizeQrImage(await makeQrPng(512));
    expect(out.contentType).toBe("image/png");
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("png");
    expect(out.width).toBe(meta.width);
    expect(out.height).toBe(meta.height);
  });

  it("strips metadata (the input fixture genuinely carries EXIF)", async () => {
    const input = await makeQrPng(512);
    // Non-vacuous: prove the input has EXIF before asserting it is gone.
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif).toBeTruthy();

    const out = await sanitizeQrImage(input);
    const outMeta = await sharp(out.data).metadata();
    expect(outMeta.exif).toBeFalsy();
  });

  it("does NOT downscale a <=1024px QR (cap only, never below scannable)", async () => {
    const input = await makeQrPng(512);
    const inMeta = await sharp(input).metadata();

    const out = await sanitizeQrImage(input);
    // A 512px QR is under the 1024 cap → preserved at its original size.
    expect(out.width).toBe(inMeta.width);
    expect(out.height).toBe(inMeta.height);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1024);
  });

  it("caps a >1024px QR at 1024 on the largest side (never upscales)", async () => {
    const input = await makeQrPng(1600);
    const out = await sanitizeQrImage(input);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1024);
    // And still scannable after the cap (see the round-trip test below).
  });

  it("round-trips a real QR: the sanitized PNG decodes to the original payload", async () => {
    // The load-bearing SCEN-007 invariant — scannability is OBSERVED by decoding
    // the sanitizer's actual output, not inferred from structural proxies.
    const out = await sanitizeQrImage(await makeQrPng(512));
    expect(await decodeQr(out.data)).toBe(PAYLOAD);
  });

  it("round-trips a capped (>1024px) QR too", async () => {
    const out = await sanitizeQrImage(await makeQrPng(1600));
    expect(await decodeQr(out.data)).toBe(PAYLOAD);
  });

  it("rejects a non-image input", async () => {
    await expect(
      sanitizeQrImage(Buffer.from("not an image at all", "utf8")),
    ).rejects.toBeInstanceOf(InvalidQrImageError);
  });

  it("rejects an empty buffer", async () => {
    await expect(sanitizeQrImage(Buffer.alloc(0))).rejects.toBeInstanceOf(
      InvalidQrImageError,
    );
  });

  it("rejects a truncated image", async () => {
    const full = await makeQrPng(256);
    await expect(
      sanitizeQrImage(full.subarray(0, 20)),
    ).rejects.toBeInstanceOf(InvalidQrImageError);
  });
});
