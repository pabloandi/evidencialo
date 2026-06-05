/**
 * Bounding-box parsing for the public map read API (step11).
 *
 * `GET /api/reports?bbox=minLng,minLat,maxLng,maxLat` accepts a viewport box and
 * returns the visible reports inside it. This module validates the untrusted
 * `bbox` query parameter BEFORE it reaches PostGIS, so a malformed or abusive
 * box becomes a structured 400 instead of an unbounded scan (SCEN-003). Output
 * mirrors `reportSchema`'s `{ ok, value } | { ok, error: { code, message } }`
 * style so the route handler maps it uniformly.
 */

export type Bbox = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

export type BboxError = {
  code: string;
  message: string;
};

export type ParseBboxResult =
  | { ok: true; value: Bbox }
  | { ok: false; error: BboxError };

const LNG_MIN = -180;
const LNG_MAX = 180;
const LAT_MIN = -90;
const LAT_MAX = 90;

// Anti-abuse cap: a single city viewport is well under 1° on either axis, so a
// 5° span is a generous ceiling that still forbids a whole-world scan (SCEN-003).
const MAX_SPAN_DEG = 5;

function invalid(): ParseBboxResult {
  return {
    ok: false,
    error: { code: "bbox_invalid", message: "Parámetro bbox inválido." },
  };
}

function tooLarge(): ParseBboxResult {
  return {
    ok: false,
    error: {
      code: "bbox_too_large",
      message: "El área solicitada es demasiado grande.",
    },
  };
}

export function parseBbox(raw: string | null): ParseBboxResult {
  if (raw === null) return invalid();

  const parts = raw.split(",");
  if (parts.length !== 4) return invalid();

  // Number() coerces "" -> 0 and " 1 " -> 1, so reject blank components first,
  // then require every part to be a finite number (rejects NaN/Infinity/abc).
  const nums: number[] = [];
  for (const part of parts) {
    if (part.trim() === "") return invalid();
    const n = Number(part);
    if (!Number.isFinite(n)) return invalid();
    nums.push(n);
  }

  const [minLng, minLat, maxLng, maxLat] = nums;

  // Ranges.
  if (minLng < LNG_MIN || minLng > LNG_MAX) return invalid();
  if (maxLng < LNG_MIN || maxLng > LNG_MAX) return invalid();
  if (minLat < LAT_MIN || minLat > LAT_MAX) return invalid();
  if (maxLat < LAT_MIN || maxLat > LAT_MAX) return invalid();

  // Ordering: a degenerate or inverted box is malformed.
  if (minLng >= maxLng) return invalid();
  if (minLat >= maxLat) return invalid();

  // Anti-abuse area cap.
  if (maxLng - minLng > MAX_SPAN_DEG || maxLat - minLat > MAX_SPAN_DEG) {
    return tooLarge();
  }

  return { ok: true, value: { minLng, minLat, maxLng, maxLat } };
}
