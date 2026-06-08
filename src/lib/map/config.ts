/**
 * Shared map configuration — the single source of truth for the public map and
 * the capture location picker (location-picker, issue #1).
 *
 * Pure data + helpers: no React, no `maplibre-gl` import, so it stays trivially
 * importable from both client components and tests. `MapView` (the public map)
 * and the upcoming `LocationPicker` MUST agree on the same Bogotá viewport and
 * the same MapTiler `dataviz` style, so both read center/zoom/style from here.
 */

// Bogotá city center — the default viewport for the public map. The tuple is
// `[lng, lat]`, the order maplibre-gl expects for `center` (a `LngLatLike`).
export const INITIAL_CENTER: [number, number] = [-74.08, 4.61];

export const INITIAL_ZOOM = 12;

/** MapTiler `dataviz` style URL keyed by `NEXT_PUBLIC_MAPTILER_KEY`. */
export function mapStyleUrl(): string {
  return `https://api.maptiler.com/maps/dataviz/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`;
}

/** True only when a MapTiler key is configured; gates any map init. */
export function hasMapKey(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_MAPTILER_KEY);
}
