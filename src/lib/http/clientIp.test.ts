import { describe, expect, it } from "vitest";

import { clientIp } from "./clientIp";

// Observable contract for clientIp (FIX 2). Header precedence:
//   x-vercel-forwarded-for (first hop) > x-real-ip > x-forwarded-for (TRAILING
//   hop) > "unknown". The first x-forwarded-for hop is client-controlled and
//   must be ignored to defeat per-IP rate-limit spoofing.

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/x", { method: "POST", headers });
}

describe("clientIp", () => {
  it("prefers x-vercel-forwarded-for (first value) over everything else", () => {
    const req = reqWith({
      "x-vercel-forwarded-for": "198.51.100.7, 10.0.0.1",
      "x-real-ip": "198.51.100.8",
      "x-forwarded-for": "9.9.9.9, 203.0.113.5",
    });
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("uses x-real-ip when no vercel header is present", () => {
    const req = reqWith({
      "x-real-ip": "198.51.100.8",
      "x-forwarded-for": "9.9.9.9, 203.0.113.5",
    });
    expect(clientIp(req)).toBe("198.51.100.8");
  });

  it("keys on the TRAILING x-forwarded-for hop, ignoring a spoofed first hop", () => {
    const req = reqWith({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" });
    expect(clientIp(req)).toBe("203.0.113.5");
  });

  it("handles a single-hop x-forwarded-for", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.5" });
    expect(clientIp(req)).toBe("203.0.113.5");
  });

  it("trims surrounding whitespace from each header value", () => {
    expect(clientIp(reqWith({ "x-vercel-forwarded-for": "  198.51.100.7  " }))).toBe(
      "198.51.100.7",
    );
    expect(clientIp(reqWith({ "x-real-ip": "  198.51.100.8  " }))).toBe(
      "198.51.100.8",
    );
    expect(clientIp(reqWith({ "x-forwarded-for": "9.9.9.9 ,  203.0.113.5 " }))).toBe(
      "203.0.113.5",
    );
  });

  it("falls back to 'unknown' when no client-ip header is present", () => {
    expect(clientIp(reqWith({}))).toBe("unknown");
  });
});
