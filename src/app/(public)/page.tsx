import type { Metadata } from "next";

import MapView from "@/components/map/MapView";

/**
 * Public map page (step11) — the app's landing route `/`.
 *
 * A static, cacheable RSC shell: it uses no dynamic APIs (no cookies/headers),
 * so Next can prerender it. All viewport data fetching happens client-side
 * inside `MapView`, which owns the MapLibre lifecycle.
 */

export const metadata: Metadata = {
  title: "evidencialo — reportes ciudadanos",
  description:
    "Mapa público de reportes ciudadanos: baches, basura y alumbrado en tu ciudad.",
};

export default function PublicMapPage() {
  return (
    <main className="public-map-shell">
      <MapView />
    </main>
  );
}
