/**
 * Pure, framework-free data helpers for the public map (step11 frontend).
 *
 * This module is the headless, fully unit-testable core of the map: it has NO
 * maplibre/WebGL/DOM imports so it runs in vitest's node environment. `MapView`
 * (the `"use client"` component) wires these into MapLibre. Keeping the logic
 * here means the data-shape and bbox-safety guarantees (public-only popup
 * fields, ≤5° span clamp, truncation gate) are verified without a browser.
 */

import type { ExpressionSpecification } from "maplibre-gl";

import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  SOLVER_TYPE_LABELS,
  STATUS_LABELS,
} from "@/lib/reportLabels";
import type { ReportMarker } from "@/lib/services/reportService";

// Re-export the shared labels so existing map imports (`./mapData`) keep working
// while the source of truth lives in the framework-free `@/lib/reportLabels`.
export { CATEGORY_COLORS, CATEGORY_LABELS, SOLVER_TYPE_LABELS, STATUS_LABELS };

const LNG_MIN = -180;
const LNG_MAX = 180;
const LAT_MIN = -90;
const LAT_MAX = 90;

// Mirror the backend anti-abuse ceiling: the API rejects a bbox spanning more
// than 5° on either axis. At city zoom this never triggers, but a programmatic
// jump (or a glitchy `getBounds`) could exceed it — so we clamp before sending.
const MAX_SPAN_DEG = 5;

// A degenerate (min === max) box would be rejected by the API as inverted; nudge
// the edges apart by a hair so the request is always a valid, non-empty box.
const MIN_SPAN_DEG = 1e-6;

/** Neutral gray for any slug the client does not yet know about. */
const CATEGORY_FALLBACK = "#868E96";

/** Resolve a category slug to its marker color, with a neutral fallback. */
export function categoryColor(slug: string): string {
  return CATEGORY_COLORS[slug] ?? CATEGORY_FALLBACK;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Shrink one axis toward its center until its span is within `MAX_SPAN_DEG`, and
 * guarantee `min < max` WITHOUT leaving the axis range. Inputs are already
 * range-clamped by the caller, so `lo`/`hi` start in `[axisMin, axisMax]`.
 *
 * The degenerate-box nudge is range-aware: opening it upward at the ceiling
 * (lat 90 / lng 180) would overshoot to e.g. 90.000001 and earn a backend 400,
 * so when `hi + MIN_SPAN_DEG` would exceed `axisMax` we open DOWNWARD instead.
 * The 5°-span clamp keeps the result well inside the 180°/360° range, so the
 * post-clamp box always satisfies geo.ts (`parseBbox`).
 */
function fitAxis(
  min: number,
  max: number,
  axisMin: number,
  axisMax: number,
): [number, number] {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);

  const span = hi - lo;
  if (span > MAX_SPAN_DEG) {
    const center = (lo + hi) / 2;
    lo = center - MAX_SPAN_DEG / 2;
    hi = center + MAX_SPAN_DEG / 2;
  } else if (span < MIN_SPAN_DEG) {
    // Degenerate box: open it by the minimum, biased INWARD so a box pinned at
    // the ceiling does not overshoot the axis range.
    if (hi + MIN_SPAN_DEG > axisMax) {
      lo = hi - MIN_SPAN_DEG;
    } else {
      hi = lo + MIN_SPAN_DEG;
    }
  }

  return [lo, hi];
}

/**
 * Turn map bounds into a safe `minLng,minLat,maxLng,maxLat` query value, or
 * `null` when the bounds are not usable.
 *
 * If ANY axis is non-finite (a glitchy `getBounds` before first layout can hand
 * back `NaN`), return `null` so the caller skips a guaranteed-400 request rather
 * than sending `"NaN,…"`. Otherwise each coordinate is clamped to its valid
 * geographic range, each axis is shrunk toward its center if it exceeds the 5°
 * anti-abuse span, `min < max` is guaranteed (range-aware nudge), and every
 * value is rounded to 6 decimals — always a bbox the backend accepts.
 */
export function boundsToBboxParam(b: {
  west: number;
  south: number;
  east: number;
  north: number;
}): string | null {
  if (
    !Number.isFinite(b.west) ||
    !Number.isFinite(b.east) ||
    !Number.isFinite(b.south) ||
    !Number.isFinite(b.north)
  ) {
    return null;
  }

  const west = clamp(b.west, LNG_MIN, LNG_MAX);
  const east = clamp(b.east, LNG_MIN, LNG_MAX);
  const south = clamp(b.south, LAT_MIN, LAT_MAX);
  const north = clamp(b.north, LAT_MIN, LAT_MAX);

  const [minLng, maxLng] = fitAxis(west, east, LNG_MIN, LNG_MAX);
  const [minLat, maxLat] = fitAxis(south, north, LAT_MIN, LAT_MAX);

  return [round6(minLng), round6(minLat), round6(maxLng), round6(maxLat)].join(
    ",",
  );
}

/**
 * Project markers into a GeoJSON FeatureCollection for the circle layer.
 *
 * `properties` carries ONLY the public fields the API exposes (id, category,
 * status, created_at) plus the public solver attribution (handle + type for the
 * claim/resolve actor, when that actor is a verified solver). It deliberately
 * never includes `reporter_id` or an address — the popup can render nothing the
 * public read did not already send. Null attribution is carried through as `null`
 * so the popup builder can branch on "resolved → claimed → none".
 */
export function reportsToFeatureCollection(
  markers: ReportMarker[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: markers.map((m) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.lng, m.lat] },
      properties: {
        id: m.id,
        category: m.category,
        status: m.status,
        created_at: m.created_at,
        claimedByHandle: m.claimedByHandle,
        claimedByType: m.claimedByType,
        resolvedByHandle: m.resolvedByHandle,
        resolvedByType: m.resolvedByType,
      },
    })),
  };
}

/**
 * Escape the five HTML-significant characters so user-derived text (a solver
 * handle or a raw type slug) can be safely interpolated into the popup's raw
 * HTML string. A crafted handle like `"><img onerror=…>` is rendered inert.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Read an optional string property: returns the trimmed value, or `null` for a
 * missing/blank/non-string value. Feature properties round-trip through GeoJSON,
 * so a `null` attribution arrives as `null` (or, defensively, absent).
 */
function optionalProp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Build the public solver attribution line for the popup, or `""` when the
 * report is unattributed.
 *
 * Resolution wins over a claim: a `resolvedByHandle` renders "Resuelto por
 * @handle"; otherwise a `claimedByHandle` renders "En proceso por @handle"
 * (SCEN-001). Each carries a verified type chip "✓ {label}" where `label` is the
 * Spanish `SOLVER_TYPE_LABELS` value (falling back to the raw type slug for a
 * future/unknown type). BOTH the handle and the type label are user-derived and
 * are HTML-escaped before interpolation.
 */
export function attributionHtml(props: Record<string, unknown>): string {
  const resolvedHandle = optionalProp(props.resolvedByHandle);
  const claimedHandle = optionalProp(props.claimedByHandle);

  let verb: string;
  let handle: string;
  let type: string | null;
  if (resolvedHandle) {
    verb = "Resuelto por";
    handle = resolvedHandle;
    type = optionalProp(props.resolvedByType);
  } else if (claimedHandle) {
    verb = "En proceso por";
    handle = claimedHandle;
    type = optionalProp(props.claimedByType);
  } else {
    return "";
  }

  const typeLabel = type ? (SOLVER_TYPE_LABELS[type] ?? type) : null;
  const chip = typeLabel
    ? `<span class="map-popup__solver-type">✓ ${escapeHtml(typeLabel)}</span>`
    : "";

  return `<p class="map-popup__solver">${escapeHtml(verb)} <span class="map-popup__handle">@${escapeHtml(handle)}</span>${chip}</p>`;
}

/**
 * Build the full popup HTML from PUBLIC feature properties only (never
 * `reporter_id`). Pure + framework-free so it is unit-tested here rather than
 * behind a maplibre canvas. `MapView` passes `feature.properties` and `now`.
 */
export function popupHtml(props: Record<string, unknown>, now: Date): string {
  const id = String(props.id ?? "");
  const category = String(props.category ?? "");
  const status = String(props.status ?? "");
  const createdAt = String(props.created_at ?? "");

  const label = CATEGORY_LABELS[category] ?? (category || "Reporte");
  const statusLabel = STATUS_LABELS[status] ?? status;
  const color = categoryColor(category);
  const relative = createdAt ? formatRelativeDate(createdAt, now) : "";
  const attribution = attributionHtml(props);

  return `
    <div class="map-popup">
      <span class="map-popup__chip" style="background:${color}">${escapeHtml(label)}</span>
      <span class="map-popup__status">${escapeHtml(statusLabel)}</span>
      ${relative ? `<time class="map-popup__date">${escapeHtml(relative)}</time>` : ""}
      ${attribution}
      ${id ? `<a class="map-popup__link" href="/reportes/${escapeHtml(id)}">Ver detalle</a>` : ""}
    </div>
  `;
}

/**
 * The maplibre `circle-color` paint expression: a `match` on the `category`
 * property mapping each known slug to its color, with the neutral fallback last.
 * Typed as `ExpressionSpecification` (a TYPE-ONLY maplibre import — no runtime
 * maplibre dependency) so callers can assign it without an `as never` cast.
 */
export function circleColorExpression(): ExpressionSpecification {
  const pairs = Object.entries(CATEGORY_COLORS).flatMap(([slug, color]) => [
    slug,
    color,
  ]);
  // The dynamic `...pairs` spread can't be statically proven to match the
  // `match` tuple shape, so we widen through `unknown` (TS's own guidance) — the
  // runtime array is exactly the maplibre `match` form the layer expects.
  return [
    "match",
    ["get", "category"],
    ...pairs,
    CATEGORY_FALLBACK,
  ] as unknown as ExpressionSpecification;
}

/** True iff the `X-Result-Truncated` header is present and exactly `"true"`. */
export function isTruncated(header: string | null): boolean {
  return header === "true";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Format an ISO timestamp as a Spanish relative date, anchored on `now` so the
 * output is deterministic (and unit-testable). Day buckets use calendar days in
 * UTC, matching how `created_at` is stored.
 */
export function formatRelativeDate(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const startOf = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((startOf(now) - startOf(then)) / MS_PER_DAY);

  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}
