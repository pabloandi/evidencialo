"use client";

/**
 * Public map (step11 frontend) — the full-screen MapLibre viewport.
 *
 * Renders a MapTiler base style and one circle marker per visible report for the
 * current viewport. On `load` it does the first `GET /api/reports?bbox=…`; every
 * `moveend` (debounced) refetches for the new bounds (SCEN-F01). Clicking a
 * marker opens a popup built from PUBLIC fields only (SCEN-F02). Without a
 * MapTiler key it renders a civic fallback card — no map init, no crash, no
 * console error (SCEN-F03). A truncated response surfaces a non-blocking
 * "zoom in" hint (SCEN-F04). Fetch failures set a quiet error state rather than
 * spamming the console, keeping the happy path console-clean (SCEN-005).
 */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

import {
  hasMapKey,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  mapStyleUrl,
} from "@/lib/map/config";
import type { ReportMarker } from "@/lib/services/reportService";

import {
  boundsToBboxParam,
  categoryColor,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  circleColorExpression,
  formatRelativeDate,
  isTruncated,
  reportsToFeatureCollection,
  STATUS_LABELS,
} from "./mapData";

const MOVE_DEBOUNCE_MS = 300;
const SOURCE_ID = "reports";
const LAYER_ID = "reports-circles";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the popup HTML from PUBLIC feature properties only (never reporter_id). */
function popupHtml(props: Record<string, unknown>, now: Date): string {
  const id = String(props.id ?? "");
  const category = String(props.category ?? "");
  const status = String(props.status ?? "");
  const createdAt = String(props.created_at ?? "");

  const label = CATEGORY_LABELS[category] ?? (category || "Reporte");
  const statusLabel = STATUS_LABELS[status] ?? status;
  const color = categoryColor(category);
  const relative = createdAt ? formatRelativeDate(createdAt, now) : "";

  return `
    <div class="map-popup">
      <span class="map-popup__chip" style="background:${color}">${escapeHtml(label)}</span>
      <span class="map-popup__status">${escapeHtml(statusLabel)}</span>
      ${relative ? `<time class="map-popup__date">${escapeHtml(relative)}</time>` : ""}
      ${id ? `<a class="map-popup__link" href="/reportes/${escapeHtml(id)}">Ver detalle</a>` : ""}
    </div>
  `;
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [truncated, setTruncated] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    // No key → fallback card is rendered below; never touch MapLibre/WebGL.
    if (!hasMapKey()) return;
    const container = containerRef.current;
    if (!container) return;

    const styleUrl = mapStyleUrl();
    const map = new maplibregl.Map({
      container,
      style: styleUrl,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    let cancelled = false;
    // Monotonic request id: every fetch captures its own `myGen` BEFORE awaiting,
    // so a slow earlier-viewport response can never overwrite the markers of a
    // later-issued one. Last writer = latest ISSUED, not latest RESOLVED.
    let generation = 0;

    async function fetchForViewport() {
      if (cancelled) return;
      const myGen = ++generation;

      const bounds = map.getBounds();
      const bbox = boundsToBboxParam({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      });
      // Non-finite bounds (a glitchy pre-layout `getBounds`) → skip the
      // guaranteed-400 request entirely.
      if (bbox === null) return;

      try {
        const res = await fetch(`/api/reports?bbox=${bbox}`, {
          headers: { accept: "application/json" },
        });
        if (cancelled || myGen !== generation) return;
        if (!res.ok) {
          setErrored(true);
          return;
        }
        const markers = (await res.json()) as ReportMarker[];
        if (cancelled || myGen !== generation) return;

        setErrored(false);
        setTruncated(isTruncated(res.headers.get("X-Result-Truncated")));

        const source = map.getSource(SOURCE_ID) as
          | maplibregl.GeoJSONSource
          | undefined;
        source?.setData(reportsToFeatureCollection(markers));
      } catch {
        // Network/JSON failure: surface a quiet toast, keep the console clean.
        if (!cancelled && myGen === generation) setErrored(true);
      }
    }

    function scheduleFetch() {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void fetchForViewport();
      }, MOVE_DEBOUNCE_MS);
    }

    map.on("load", () => {
      if (cancelled) return;

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: reportsToFeatureCollection([]),
      });

      map.addLayer({
        id: LAYER_ID,
        source: SOURCE_ID,
        type: "circle",
        paint: {
          "circle-color": circleColorExpression(),
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            4,
            16,
            9,
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#FFFFFF",
        },
      });

      // First load fires immediately; subsequent moves are debounced.
      void fetchForViewport();
      map.on("moveend", scheduleFetch);

      // The whole layer lifecycle (source + layer + interactions) lives here so
      // the handlers can only ever attach to an existing layer.
      map.on("click", LAYER_ID, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const geometry = feature.geometry;
        if (geometry.type !== "Point") return;
        const [lng, lat] = geometry.coordinates as [number, number];

        new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
          .setLngLat([lng, lat])
          .setHTML(popupHtml(feature.properties ?? {}, new Date()))
          .addTo(map);
      });

      map.on("mouseenter", LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- Missing-key fallback (SCEN-F03): a civic card, never a blank/crash ----
  if (!hasMapKey()) {
    return (
      <div className="map-fallback" role="alert">
        <div className="map-fallback__card">
          <p className="map-fallback__brand">evidencialo</p>
          <h1 className="map-fallback__title">El mapa necesita configuración</h1>
          <p className="map-fallback__body">
            Falta la clave de MapTiler para mostrar el mapa de reportes. Cuando
            esté configurada, aquí verás los reportes ciudadanos de tu ciudad.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="map-root">
      <div
        ref={containerRef}
        className="map-canvas"
        role="region"
        aria-label="Mapa de reportes ciudadanos"
      />

      <header className="map-header">
        <div className="map-header__brand-group">
          <h1 className="map-header__brand">evidencialo</h1>
          <p className="map-header__tagline">Reportes ciudadanos en tu ciudad</p>
        </div>
        {/* "Reportar" is the primary action; "Mis reportes" gates to /ingresar
            when anonymous via the (account) layout. */}
        <nav className="map-header__nav" aria-label="Acciones">
          <a className="map-header__nav-cta" href="/reportar">
            Reportar
          </a>
          <a className="map-header__nav-link" href="/mis-reportes">
            Mis reportes
          </a>
        </nav>
      </header>

      <section className="map-legend" aria-label="Categorías de reportes">
        <h2 className="map-legend__title">Categorías</h2>
        <ul className="map-legend__list">
          {Object.entries(CATEGORY_LABELS).map(([slug, label]) => (
            <li key={slug} className="map-legend__item">
              <span
                className="map-legend__dot"
                style={{ background: CATEGORY_COLORS[slug] }}
                aria-hidden="true"
              />
              {label}
            </li>
          ))}
        </ul>
      </section>

      {truncated && (
        <p className="map-hint" role="status">
          Acércate para ver más reportes
        </p>
      )}

      {errored && (
        <p className="map-toast" role="status">
          No se pudieron cargar los reportes. Reintenta moviendo el mapa.
        </p>
      )}
    </div>
  );
}
