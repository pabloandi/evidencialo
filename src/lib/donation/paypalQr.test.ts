import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { InvalidPaypalUrlError, paypalQrSvg } from "./paypalQr";

// Observable contract for the PayPal QR utility (D2, SCEN-008): a deterministic
// inline SVG encoding the normalized https://paypal.me/<user> URL for a known
// user, and a hard guard that ONLY a normalized paypal.me URL is ever encoded.

const URL = "https://paypal.me/johndoe";

describe("paypalQrSvg", () => {
  it("returns a complete inline SVG document", async () => {
    const svg = await paypalQrSvg(URL);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("is deterministic for a given URL (byte-identical across calls)", async () => {
    const a = await paypalQrSvg(URL);
    const b = await paypalQrSvg(URL);
    expect(a).toBe(b);
  });

  it("encodes the exact normalized URL (decodes back to it)", async () => {
    const svg = await paypalQrSvg(URL);
    // Rasterize the SVG and decode it — the QR must carry the URL verbatim.
    const { data, info } = await sharp(Buffer.from(svg))
      .resize({ width: 512, height: 512, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const decoded = jsQR(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(URL);
  });

  it("differs for a different user", async () => {
    const a = await paypalQrSvg("https://paypal.me/alice");
    const b = await paypalQrSvg("https://paypal.me/bob");
    expect(a).not.toBe(b);
  });

  it("rejects a non-paypal.me URL", async () => {
    await expect(paypalQrSvg("https://evil.com/johndoe")).rejects.toBeInstanceOf(
      InvalidPaypalUrlError,
    );
  });

  it("rejects a bare username (must be the normalized URL)", async () => {
    await expect(paypalQrSvg("johndoe")).rejects.toBeInstanceOf(
      InvalidPaypalUrlError,
    );
  });

  it("rejects a paypal.me URL with an extra path segment", async () => {
    await expect(
      paypalQrSvg("https://paypal.me/johndoe/extra"),
    ).rejects.toBeInstanceOf(InvalidPaypalUrlError);
  });

  it("rejects an http (non-https) paypal.me URL", async () => {
    await expect(
      paypalQrSvg("http://paypal.me/johndoe"),
    ).rejects.toBeInstanceOf(InvalidPaypalUrlError);
  });
});
