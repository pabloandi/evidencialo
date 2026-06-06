/**
 * Shared, framework-free report labels and colors.
 *
 * These maps are the single source of truth for how a report's category and
 * status are presented in Spanish, plus the per-category marker color. They live
 * here (no React, no maplibre, no DOM) so BOTH the public map chrome
 * (`src/components/map/*`) and the server-rendered detail page
 * (`src/lib/services/reportDetailService.ts` + `/reportes/[id]`) read from one
 * place — the map re-exports them to keep its existing imports working.
 */

/** Marker fill colors per category slug. Drives the legend, the layer, and the chip. */
export const CATEGORY_COLORS: Record<string, string> = {
  bache: "#E8590C",
  basura: "#2F9E44",
  alumbrado: "#1971C2",
};

/** Spanish display labels per category slug (legend + popup chip + detail chip). */
export const CATEGORY_LABELS: Record<string, string> = {
  bache: "Bache",
  basura: "Basura",
  alumbrado: "Alumbrado",
};

/**
 * Spanish display labels for the `report_status` enum (popup + detail badge).
 * Consumers use `STATUS_LABELS[status] ?? status` so a future enum value degrades
 * to its raw slug instead of rendering an ugly capitalized snake_case string.
 */
export const STATUS_LABELS: Record<string, string> = {
  nuevo: "Nuevo",
  en_proceso: "En proceso",
  resuelto: "Resuelto",
  descartado: "Descartado",
};
