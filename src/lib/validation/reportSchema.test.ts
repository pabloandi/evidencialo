import { describe, expect, it } from "vitest";

import { validateReportInput } from "./reportSchema";

// Observable contract for input validation (step05). Each case encodes a
// committed scenario in `report-create.scenarios.md`: the FIRST violation is
// returned as a single { code, message, field? } error, with the exact Spanish
// message the API exposes to citizens. The valid baseline (SCEN-001) parses.

const baseline = {
  category: "bache",
  lat: 4.6097,
  lng: -74.0817,
  description: "Bache profundo frente al colegio, peligroso para motos.",
  media: [{ type: "image", mime: "image/jpeg", size: 2000000 }],
};

describe("validateReportInput", () => {
  it("accepts the valid baseline payload (SCEN-001)", () => {
    const result = validateReportInput(baseline);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.category).toBe("bache");
      expect(result.value.lat).toBe(4.6097);
      expect(result.value.lng).toBe(-74.0817);
      expect(result.value.media).toHaveLength(1);
      expect(result.value.media[0]).toMatchObject({
        type: "image",
        mime: "image/jpeg",
        size: 2000000,
      });
    }
  });

  it("rejects a non-object body with 422-grade error", () => {
    const result = validateReportInput("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error.code).toBe("string");
  });

  it("rejects an image over the 10 MB size limit (SCEN-003)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [{ type: "image", mime: "image/jpeg", size: 12000000 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("media_too_large");
      expect(result.error.message).toBe(
        "La imagen supera el tamaño máximo de 10 MB.",
      );
      expect(result.error.field).toBe("media.0.size");
    }
  });

  it("rejects more than three images (SCEN-004)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [
        { type: "image", mime: "image/jpeg", size: 1000000 },
        { type: "image", mime: "image/jpeg", size: 1000000 },
        { type: "image", mime: "image/jpeg", size: 1000000 },
        { type: "image", mime: "image/jpeg", size: 1000000 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("too_many_images");
      expect(result.error.message).toBe("Máximo 3 imágenes por reporte.");
      expect(result.error.field).toBe("media");
    }
  });

  it("rejects a disallowed image format (SCEN-005)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [{ type: "image", mime: "image/gif", size: 2000000 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("media_format_invalid");
      expect(result.error.message).toBe(
        "Formato de imagen no permitido. Usa JPEG, PNG o WebP.",
      );
    }
  });

  it("rejects out-of-range coordinates (SCEN-006)", () => {
    const result = validateReportInput({ ...baseline, lat: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("coordinates_out_of_range");
      expect(result.error.message).toBe("Coordenadas fuera de rango.");
      expect(result.error.field).toBe("lat");
    }
  });

  it("rejects a video over its size/duration limits (SCEN-008)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [
        { type: "video", mime: "video/mp4", size: 60000000, duration_s: 90 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["media_too_large", "video_too_long"]).toContain(
        result.error.code,
      );
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it("rejects empty media (SCEN-009)", () => {
    const result = validateReportInput({ ...baseline, media: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("media_required");
      expect(result.error.message).toBe("Adjunta al menos una foto o video.");
      expect(result.error.field).toBe("media");
    }
  });

  it("rejects a missing category", () => {
    const withoutCategory = {
      lat: baseline.lat,
      lng: baseline.lng,
      description: baseline.description,
      media: baseline.media,
    };
    const result = validateReportInput(withoutCategory);
    expect(result.ok).toBe(false);
  });

  // SCEN-011: malformed numerics are structurally rejected (422, never a 500
  // from a downstream DB type error). The exact code may be `invalid_payload`
  // (structural) — the contract only requires ok:false with a structured error.
  it("rejects a non-integer media size (SCEN-011: size = 30.5)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [{ type: "image", mime: "image/jpeg", size: 30.5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe("string");
      expect(result.error.code.length).toBeGreaterThan(0);
    }
  });

  it("rejects a non-positive media size (SCEN-011: size = 0)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [{ type: "image", mime: "image/jpeg", size: 0 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe("string");
      expect(result.error.code.length).toBeGreaterThan(0);
    }
  });

  it("rejects a negative media size (SCEN-011: size = -1)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [{ type: "image", mime: "image/jpeg", size: -1 }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer video duration (SCEN-011: duration_s = 45.7)", () => {
    const result = validateReportInput({
      ...baseline,
      media: [
        { type: "video", mime: "video/mp4", size: 2000000, duration_s: 45.7 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe("string");
      expect(result.error.code.length).toBeGreaterThan(0);
    }
  });

  it("rejects non-finite coordinates (SCEN-011: lat = Infinity)", () => {
    const result = validateReportInput({ ...baseline, lat: Infinity });
    expect(result.ok).toBe(false);
  });
});
