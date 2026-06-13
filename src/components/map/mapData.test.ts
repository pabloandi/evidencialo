import { describe, expect, it } from "vitest";

import type { ReportMarker } from "@/lib/services/reportService";

import {
  attributionHtml,
  boundsToBboxParam,
  categoryColor,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  circleColorExpression,
  corroborationHtml,
  escapeHtml,
  formatRelativeDate,
  isTruncated,
  popupHtml,
  reportsToFeatureCollection,
  STATUS_LABELS,
} from "./mapData";

/**
 * Re-validate a bbox param string against the SAME invariants the backend
 * `parseBbox` (src/lib/geo.ts) enforces: 4 finite numbers, each in geographic
 * range, strict min<max on both axes, and ≤5° span. Mirrors geo.ts so the
 * client can never emit a box that earns a 400.
 */
function expectBackendValid(param: string): void {
  const parts = param.split(",");
  expect(parts).toHaveLength(4);
  const [minLng, minLat, maxLng, maxLat] = parts.map(Number);
  for (const n of [minLng, minLat, maxLng, maxLat]) {
    expect(Number.isFinite(n)).toBe(true);
  }
  expect(minLng).toBeGreaterThanOrEqual(-180);
  expect(maxLng).toBeLessThanOrEqual(180);
  expect(minLat).toBeGreaterThanOrEqual(-90);
  expect(maxLat).toBeLessThanOrEqual(90);
  expect(minLng).toBeLessThan(maxLng);
  expect(minLat).toBeLessThan(maxLat);
  expect(maxLng - minLng).toBeLessThanOrEqual(5);
  expect(maxLat - minLat).toBeLessThanOrEqual(5);
}

describe("boundsToBboxParam", () => {
  it("formats a normal city viewport as minLng,minLat,maxLng,maxLat", () => {
    const param = boundsToBboxParam({
      west: -74.1,
      south: 4.6,
      east: -74.06,
      north: 4.62,
    });
    expect(param).toBe("-74.1,4.6,-74.06,4.62");
  });

  it("clamps a span larger than 5° toward the center on the lng axis", () => {
    // 20° wide box centered at 0 → must shrink to exactly 5° (center 0 → -2.5..2.5).
    const param = boundsToBboxParam({
      west: -10,
      south: 4.6,
      east: 10,
      north: 4.62,
    });
    const [minLng, , maxLng] = param!.split(",").map(Number);
    expect(maxLng - minLng).toBeCloseTo(5, 6);
    expect((minLng + maxLng) / 2).toBeCloseTo(0, 6);
  });

  it("clamps a span larger than 5° toward the center on the lat axis", () => {
    const param = boundsToBboxParam({
      west: -74.1,
      south: -10,
      east: -74.06,
      north: 10,
    });
    const [, minLat, , maxLat] = param!.split(",").map(Number);
    expect(maxLat - minLat).toBeCloseTo(5, 6);
    expect((minLat + maxLat) / 2).toBeCloseTo(0, 6);
  });

  it("clamps coordinates that fall outside the valid lng/lat ranges", () => {
    const param = boundsToBboxParam({
      west: -400,
      south: -200,
      east: 400,
      north: 200,
    });
    const [minLng, minLat, maxLng, maxLat] = param!.split(",").map(Number);
    expect(minLng).toBeGreaterThanOrEqual(-180);
    expect(maxLng).toBeLessThanOrEqual(180);
    expect(minLat).toBeGreaterThanOrEqual(-90);
    expect(maxLat).toBeLessThanOrEqual(90);
  });

  it("guarantees min < max even for an inverted/degenerate input box", () => {
    const param = boundsToBboxParam({
      west: 5,
      south: 5,
      east: 5,
      north: 5,
    });
    const [minLng, minLat, maxLng, maxLat] = param!.split(",").map(Number);
    expect(minLng).toBeLessThan(maxLng);
    expect(minLat).toBeLessThan(maxLat);
  });

  it("rounds each coordinate to 6 decimal places", () => {
    const param = boundsToBboxParam({
      west: -74.123456789,
      south: 4.987654321,
      east: -74.000000001,
      north: 4.999999999,
    });
    expect(param).not.toBeNull();
    for (const part of param!.split(",")) {
      const decimals = part.includes(".") ? part.split(".")[1].length : 0;
      expect(decimals).toBeLessThanOrEqual(6);
    }
    expect(param!.split(",")[0]).toBe("-74.123457");
  });

  it("returns null when any axis is NaN or Infinity", () => {
    const finite = { west: -74.1, south: 4.6, east: -74.06, north: 4.62 };
    expect(boundsToBboxParam({ ...finite, west: NaN })).toBeNull();
    expect(boundsToBboxParam({ ...finite, east: Infinity })).toBeNull();
    expect(boundsToBboxParam({ ...finite, south: -Infinity })).toBeNull();
    expect(boundsToBboxParam({ ...finite, north: NaN })).toBeNull();
  });

  it("stays backend-valid for a normal city viewport", () => {
    const param = boundsToBboxParam({
      west: -74.1,
      south: 4.6,
      east: -74.06,
      north: 4.62,
    });
    expect(param).not.toBeNull();
    expectBackendValid(param!);
  });

  it("biases the degenerate nudge INWARD at the lat/lng ceiling (90/180)", () => {
    // A degenerate box pinned at the north-east ceiling must NOT overshoot to
    // 90.000001 / 180.000001 (backend 400). The nudge opens downward instead.
    const param = boundsToBboxParam({
      west: 180,
      south: 90,
      east: 180,
      north: 90,
    });
    expect(param).not.toBeNull();
    expectBackendValid(param!);
    const [minLng, minLat, maxLng, maxLat] = param!.split(",").map(Number);
    expect(maxLng).toBeLessThanOrEqual(180);
    expect(maxLat).toBeLessThanOrEqual(90);
    expect(minLng).toBeLessThan(maxLng);
    expect(minLat).toBeLessThan(maxLat);
  });

  it("biases the degenerate nudge at the lat/lng floor (-90/-180) and stays valid", () => {
    const param = boundsToBboxParam({
      west: -180,
      south: -90,
      east: -180,
      north: -90,
    });
    expect(param).not.toBeNull();
    expectBackendValid(param!);
  });
});

describe("reportsToFeatureCollection", () => {
  const marker: ReportMarker = {
    id: "r1",
    lng: -74.08,
    lat: 4.61,
    category: "bache",
    status: "nuevo",
    created_at: "2026-06-01T12:00:00.000Z",
    claimedByHandle: null,
    claimedByType: null,
    resolvedByHandle: null,
    resolvedByType: null,
    verifiedCount: 0,
    anonCount: 0,
    corroborated: false,
  };

  it("emits one Point feature per marker with [lng, lat] coordinates", () => {
    const fc = reportsToFeatureCollection([marker]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry.type).toBe("Point");
    expect(f.geometry.coordinates).toEqual([-74.08, 4.61]);
  });

  it("exposes exactly the public property set (incl. solver attribution) — and NO reporter_id", () => {
    const fc = reportsToFeatureCollection([marker]);
    const props = fc.features[0].properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      [
        "anonCount",
        "category",
        "claimedByHandle",
        "claimedByType",
        "corroborated",
        "created_at",
        "id",
        "resolvedByHandle",
        "resolvedByType",
        "status",
        "verifiedCount",
      ].sort(),
    );
    expect(props).not.toHaveProperty("reporter_id");
    expect(props).not.toHaveProperty("address");
  });

  it("carries the corroboration counts/flag through to feature properties", () => {
    const corroborated: ReportMarker = {
      ...marker,
      verifiedCount: 3,
      anonCount: 2,
      corroborated: true,
    };
    const props = reportsToFeatureCollection([corroborated]).features[0]
      .properties as Record<string, unknown>;
    expect(props.verifiedCount).toBe(3);
    expect(props.anonCount).toBe(2);
    expect(props.corroborated).toBe(true);
  });

  it("carries the solver attribution through to feature properties", () => {
    const attributed: ReportMarker = {
      ...marker,
      status: "en_proceso",
      claimedByHandle: "alcaldia",
      claimedByType: "government",
    };
    const props = reportsToFeatureCollection([attributed]).features[0]
      .properties as Record<string, unknown>;
    expect(props.claimedByHandle).toBe("alcaldia");
    expect(props.claimedByType).toBe("government");
    expect(props.resolvedByHandle).toBeNull();
  });

  it("returns an empty FeatureCollection for an empty array", () => {
    const fc = reportsToFeatureCollection([]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toEqual([]);
  });
});

describe("escapeHtml", () => {
  it("neutralizes the HTML-significant characters", () => {
    expect(escapeHtml(`"><img src=x onerror=alert(1)>`)).toBe(
      "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeHtml("a & b 'q'")).toBe("a &amp; b &#39;q&#39;");
  });
});

describe("attributionHtml (SCEN-001)", () => {
  const base = {
    claimedByHandle: null,
    claimedByType: null,
    resolvedByHandle: null,
    resolvedByType: null,
  };

  it("renders 'En proceso por @handle' + verified type chip when only claimed", () => {
    const html = attributionHtml({
      ...base,
      claimedByHandle: "alcaldia",
      claimedByType: "government",
    });
    expect(html).toContain("En proceso por");
    expect(html).toContain("@alcaldia");
    expect(html).toContain("✓ Gobierno");
    expect(html).not.toContain("Resuelto por");
  });

  it("renders 'Resuelto por @handle' and PREFERS resolve over a present claim", () => {
    const html = attributionHtml({
      ...base,
      claimedByHandle: "alcaldia",
      claimedByType: "government",
      resolvedByHandle: "fundacion",
      resolvedByType: "org",
    });
    expect(html).toContain("Resuelto por");
    expect(html).toContain("@fundacion");
    expect(html).toContain("✓ Organización");
    expect(html).not.toContain("En proceso por");
    expect(html).not.toContain("@alcaldia");
  });

  it("falls back to the raw type slug for an unknown solver type", () => {
    const html = attributionHtml({
      ...base,
      resolvedByHandle: "nuevo_actor",
      resolvedByType: "cooperative",
    });
    expect(html).toContain("✓ cooperative");
  });

  it("omits the type chip entirely when no type is present", () => {
    const html = attributionHtml({ ...base, claimedByHandle: "solo_handle" });
    expect(html).toContain("@solo_handle");
    expect(html).not.toContain("✓");
  });

  it("returns an empty string for an unattributed report", () => {
    expect(attributionHtml(base)).toBe("");
    expect(attributionHtml({})).toBe("");
  });

  it("HTML-escapes a crafted handle and type so the popup cannot be injected", () => {
    const html = attributionHtml({
      ...base,
      resolvedByHandle: `x"><img src=y onerror=alert(1)>`,
      resolvedByType: `<b>org</b>`,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;org&lt;/b&gt;");
  });
});

describe("corroborationHtml (subsystem A)", () => {
  it("renders the 'Corroborado ✓' chip + verified count when corroborated", () => {
    const html = corroborationHtml({
      corroborated: true,
      verifiedCount: 3,
      anonCount: 2,
    });
    expect(html).toContain("Corroborado ✓");
    expect(html).toContain("map-popup__corroboration");
    expect(html).toContain("3 verificadas");
  });

  it("uses the singular form for exactly one verified confirmation", () => {
    const html = corroborationHtml({ corroborated: true, verifiedCount: 1 });
    expect(html).toContain("1 verificada");
    expect(html).not.toContain("verificadas");
  });

  it("returns an empty string when the report is not corroborated", () => {
    expect(corroborationHtml({ corroborated: false, verifiedCount: 2 })).toBe(
      "",
    );
    expect(corroborationHtml({})).toBe("");
  });

  it("coerces a non-numeric/absent count to 0 rather than NaN", () => {
    const html = corroborationHtml({ corroborated: true });
    expect(html).toContain("0 verificadas");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
});

describe("popupHtml", () => {
  const now = new Date("2026-06-04T12:00:00.000Z");
  const baseProps = {
    id: "rep-1",
    category: "bache",
    status: "nuevo",
    created_at: "2026-06-04T08:00:00.000Z",
    claimedByHandle: null,
    claimedByType: null,
    resolvedByHandle: null,
    resolvedByType: null,
    verifiedCount: 0,
    anonCount: 0,
    corroborated: false,
  };

  it("renders the category chip, status, date and detail link", () => {
    const html = popupHtml(baseProps, now);
    expect(html).toContain("Bache");
    expect(html).toContain("Nuevo");
    expect(html).toContain("hoy");
    expect(html).toContain(`href="/reportes/rep-1"`);
  });

  it("includes the attribution line for a resolved+attributed marker", () => {
    const html = popupHtml(
      {
        ...baseProps,
        status: "resuelto",
        resolvedByHandle: "alcaldia",
        resolvedByType: "government",
      },
      now,
    );
    expect(html).toContain("Resuelto por");
    expect(html).toContain("@alcaldia");
    expect(html).toContain("✓ Gobierno");
  });

  it("shows NO attribution line for an unattributed marker", () => {
    const html = popupHtml(baseProps, now);
    expect(html).not.toContain("Resuelto por");
    expect(html).not.toContain("En proceso por");
    expect(html).not.toContain("map-popup__solver");
  });

  it("includes the corroboration snippet for a corroborated marker", () => {
    const html = popupHtml(
      { ...baseProps, verifiedCount: 4, corroborated: true },
      now,
    );
    expect(html).toContain("Corroborado ✓");
    expect(html).toContain("map-popup__corroboration");
    expect(html).toContain("4 verificadas");
  });

  it("shows NO corroboration snippet for a non-corroborated marker", () => {
    const html = popupHtml(baseProps, now);
    expect(html).not.toContain("Corroborado");
    expect(html).not.toContain("map-popup__corroboration");
  });
});

describe("categoryColor / CATEGORY_COLORS / CATEGORY_LABELS", () => {
  it("returns the configured color for each known slug", () => {
    expect(categoryColor("bache")).toBe("#E8590C");
    expect(categoryColor("basura")).toBe("#2F9E44");
    expect(categoryColor("alumbrado")).toBe("#1971C2");
    expect(CATEGORY_COLORS.bache).toBe("#E8590C");
  });

  it("falls back to the neutral gray for an unknown slug", () => {
    expect(categoryColor("desconocido")).toBe("#868E96");
    expect(categoryColor("")).toBe("#868E96");
  });

  it("maps known slugs to Spanish labels", () => {
    expect(CATEGORY_LABELS.bache).toBe("Bache");
    expect(CATEGORY_LABELS.basura).toBe("Basura");
    expect(CATEGORY_LABELS.alumbrado).toBe("Alumbrado");
  });
});

describe("STATUS_LABELS", () => {
  it("maps each report_status enum value to its Spanish display", () => {
    expect(STATUS_LABELS.nuevo).toBe("Nuevo");
    expect(STATUS_LABELS.en_proceso).toBe("En proceso");
    expect(STATUS_LABELS.resuelto).toBe("Resuelto");
    expect(STATUS_LABELS.descartado).toBe("Descartado");
  });

  it("leaves an unknown status to fall through to the raw value", () => {
    // The popup uses `STATUS_LABELS[status] ?? status`, so a future/unknown
    // enum value renders as-is rather than crashing or showing "undefined".
    const unknown = "en_revision";
    expect(STATUS_LABELS[unknown] ?? unknown).toBe("en_revision");
  });
});

describe("circleColorExpression", () => {
  it("is a maplibre match expression keyed on the category property", () => {
    const expr = circleColorExpression() as unknown[];
    expect(expr[0]).toBe("match");
    expect(expr[1]).toEqual(["get", "category"]);
    // Contains each known slug → color pair and a trailing fallback color.
    expect(expr).toContain("bache");
    expect(expr).toContain("#E8590C");
    expect(expr[expr.length - 1]).toBe("#868E96");
  });
});

describe("isTruncated", () => {
  it("is true only when the header is exactly the string 'true'", () => {
    expect(isTruncated("true")).toBe(true);
  });

  it("is false for 'false', any other value, and null", () => {
    expect(isTruncated("false")).toBe(false);
    expect(isTruncated("TRUE")).toBe(false);
    expect(isTruncated("1")).toBe(false);
    expect(isTruncated(null)).toBe(false);
  });
});

describe("formatRelativeDate", () => {
  const now = new Date("2026-06-04T12:00:00.000Z");

  it("says 'hoy' for a timestamp from the same day", () => {
    expect(formatRelativeDate("2026-06-04T08:00:00.000Z", now)).toBe("hoy");
  });

  it("says 'ayer' for a timestamp one day earlier", () => {
    expect(formatRelativeDate("2026-06-03T08:00:00.000Z", now)).toBe("ayer");
  });

  it("pluralizes days for older timestamps", () => {
    expect(formatRelativeDate("2026-06-02T08:00:00.000Z", now)).toBe(
      "hace 2 días",
    );
  });
});
