import QRCode from "qrcode";

/**
 * Server-side PayPal QR generation (subsystem D, chunk D2; SCEN-008).
 *
 * A PayPal channel is a plain `https://paypal.me/<user>` URL — the one donation
 * rail whose QR is safe to GENERATE (the Colombian rails are app-minted EMVCo /
 * Bre-B payloads that cannot be synthesized from a number, so those are
 * uploaded). Any phone camera opening this QR lands on the donor-pays page.
 *
 * Emitted as inline SVG (no client JS, no `<img>` round trip) for the public
 * profile. The `qrcode` lib's `toString(text, { type: 'svg' })` returns a
 * complete SVG document string (API verified via Context7 + an empirical probe
 * at implementation time). Output is DETERMINISTIC for a given URL: a fixed
 * error-correction level and margin, no randomized ids.
 *
 * Guard: ONLY a normalized `https://paypal.me/<user>` URL is ever encoded —
 * `donationSchema` produces exactly that, but this util re-checks so a caller
 * can never coax an arbitrary URL into a generated QR.
 */

/** The exact normalized shape `donationSchema` emits for a PayPal channel. */
const PAYPAL_URL_RE = /^https:\/\/paypal\.me\/[A-Za-z0-9]{1,20}$/;

export class InvalidPaypalUrlError extends Error {
  constructor(public readonly url: string) {
    super(`not a normalized paypal.me URL: ${url}`);
    this.name = "InvalidPaypalUrlError";
  }
}

/**
 * Return an inline SVG QR encoding the normalized `https://paypal.me/<user>`
 * URL. Throws `InvalidPaypalUrlError` for anything that is not exactly that
 * shape (defense in depth over `donationSchema`).
 */
export async function paypalQrSvg(normalizedUrl: string): Promise<string> {
  if (!PAYPAL_URL_RE.test(normalizedUrl)) {
    throw new InvalidPaypalUrlError(normalizedUrl);
  }

  return QRCode.toString(normalizedUrl, {
    type: "svg",
    // 'M' (~15% recovery) is plenty for a short URL on a screen/print and keeps
    // the module count — and thus the SVG bytes — deterministic and compact.
    errorCorrectionLevel: "M",
    // A 4-module quiet zone is the spec minimum for reliable scanning.
    margin: 4,
  });
}
