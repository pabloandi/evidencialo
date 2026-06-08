"use client";

/**
 * Location picker (location-picker, issue #1) — a controlled full-screen sheet
 * for choosing ONE point with the center-pin pattern (Uber/Rappi style).
 *
 * The map fills the sheet; the pin is a FIXED CSS overlay centered over the map
 * container (NOT a maplibre Marker). The user drags the map underneath, so the
 * chosen coordinate is always `map.getCenter()` at the moment of confirm.
 *
 * It does NOT reuse `MapView.tsx` (that one is coupled to fetching reports and
 * marker layers) — both only share the MapLibre init idioms and the map config
 * in `@/lib/map/config` (same Bogotá viewport + MapTiler `dataviz` style).
 *
 * Boundary: knows nothing about reports/categories/captcha. It receives an
 * `initialCenter` and returns a `{lat,lng}` via `onConfirm` / closes via
 * `onCancel`. `CaptureForm` owns when it opens and what to do with the result.
 *
 * GPS is a CONVENIENCE shortcut, never a blocker: the map opens immediately on
 * `initialCenter`; "Usar mi ubicación" only `flyTo`s a fix if a non-blocking
 * `getPosition()` resolves. A denial sets a quiet inline note — manual pick
 * still works (SCEN-005).
 *
 * Map init has its OWN error surface (unlike `MapView`, which returns a fallback
 * card on a missing key): a `hasMapKey()` guard AND a `map.on('error', …)`
 * listener for runtime failures (bad style fetch, WebGL unavailable) surface a
 * readable message with "Cancelar" still available — never a silent success.
 *
 * a11y: `role="dialog"` + `aria-modal`, focus moves into the sheet on open and
 * restores on close, focus is trapped, and Escape cancels.
 */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

import { hasMapKey, INITIAL_ZOOM, mapStyleUrl } from "@/lib/map/config";
import { getPosition } from "@/lib/native/capture";

type Point = { lat: number; lng: number };

export type LocationPickerProps = {
  initialCenter: Point;
  onConfirm: (point: Point) => void;
  onCancel: () => void;
};

const GPS_DENIED_NOTE =
  "No pudimos obtener tu ubicación; mueve el mapa para fijar el punto.";
const MAP_ERROR_MESSAGE =
  "No pudimos cargar el mapa. Cierra y vuelve a intentarlo.";

/** Focusable elements inside the sheet, for the focus trap. */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function LocationPicker({
  initialCenter,
  onConfirm,
  onCancel,
}: LocationPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest onCancel without re-running the key/focus effect on each render.
  const onCancelRef = useRef(onCancel);
  // Tracks mount state so the async GPS path never setStates after unmount. The
  // web `getPosition()` has a 15s timeout, so a user can cancel/unmount with a
  // long-pending request still in flight.
  const mountedRef = useRef(true);

  const keyAvailable = hasMapKey();

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sync the cancel ref in an effect (never during render) so the keydown
  // handler always sees the latest callback without re-binding the listener.
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  const [locating, setLocating] = useState(false);
  const [gpsDenied, setGpsDenied] = useState(false);
  // Map failed to initialize / a runtime map error fired (no key, bad style, WebGL).
  const [mapError, setMapError] = useState(!keyAvailable);

  // ---- Map lifecycle: init on mount, remove on unmount -----------------------
  useEffect(() => {
    // No key → the error state is rendered below; never touch MapLibre/WebGL.
    if (!keyAvailable) return;
    const container = containerRef.current;
    if (!container) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: mapStyleUrl(),
        center: [initialCenter.lng, initialCenter.lat],
        zoom: INITIAL_ZOOM,
      });
    } catch {
      // A throw from `new maplibregl.Map(...)` (e.g. no WebGL) is a hard failure.
      // Defer the flag to a microtask so it is set from a callback rather than
      // synchronously in the effect body (no cascading-render lint violation).
      queueMicrotask(() => setMapError(true));
      return;
    }
    mapRef.current = map;

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );

    // Runtime failures (style fetch 4xx, WebGL lost) → readable message, no crash.
    map.on("error", () => {
      setMapError(true);
    });

    return () => {
      // `map.remove()` tears down the GL context. The async GPS path guards on
      // `mountedRef` (not a nulled `mapRef`), so the stale ref is never read
      // after unmount — keeping the `mountedRef` check the single, testable
      // line of defense for the post-unmount race.
      map.remove();
    };
    // initialCenter is the open-time viewport; re-centering on prop change is not
    // a use case (the picker is remounted by the parent when reopened).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyAvailable]);

  // ---- a11y: focus into the sheet on open, restore on close, Escape cancels ---
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const sheet = sheetRef.current;
    // Move focus into the sheet so keyboard users start inside the dialog.
    sheet?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      // Trap focus: cycle within the sheet's focusable elements.
      const focusables = sheet
        ? Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        : [];
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger on close — but only if it is still in the
      // DOM. A detached node's `.focus()` silently dumps focus to <body>.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  async function onUseLocation() {
    setLocating(true);
    setGpsDenied(false);
    try {
      const point = await getPosition();
      // The request can outlive the dialog (15s web timeout): bail before any
      // setState/map access if the user cancelled/unmounted while it was pending.
      if (!mountedRef.current) return;
      // The pin stays centered, so the chosen point becomes the GPS point until
      // the user pans away.
      mapRef.current?.flyTo({ center: [point.lng, point.lat] });
    } catch {
      // Non-blocking: a denial (or any failure) shows a note; manual pick works.
      if (mountedRef.current) setGpsDenied(true);
    } finally {
      if (mountedRef.current) setLocating(false);
    }
  }

  function onConfirmClick() {
    const map = mapRef.current;
    // No map → a broken dialog (post-constructor-throw window before `mapError`
    // flips). Close it rather than leaving a dead "Confirmar" button.
    if (!map) {
      onCancel();
      return;
    }
    const center = map.getCenter();
    // maplibre returns {lng,lat}; the contract with the form is {lat,lng}.
    onConfirm({ lat: center.lat, lng: center.lng });
  }

  // ---- Map init failure: readable message + Cancelar (NO map) -----------------
  if (mapError) {
    return (
      <div
        className="location-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Elegir ubicación en el mapa"
        ref={sheetRef}
      >
        <div className="location-picker__error" role="alert">
          <p className="location-picker__error-text">{MAP_ERROR_MESSAGE}</p>
          <button
            type="button"
            className="capture-btn capture-btn--secondary"
            onClick={onCancel}
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="location-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Elegir ubicación en el mapa"
      ref={sheetRef}
    >
      <div
        ref={containerRef}
        className="location-picker__map"
        role="application"
        aria-label="Mapa para elegir la ubicación del reporte"
      />

      {/* Fixed center pin: a CSS overlay, NOT a maplibre Marker. */}
      <div className="location-picker__pin" aria-hidden="true">
        <span className="location-picker__pin-dot" />
        <span className="location-picker__pin-stem" />
      </div>

      <p className="location-picker__hint" role="status">
        Arrastra el mapa para fijar el punto bajo el pin.
      </p>

      {gpsDenied && (
        <p className="location-picker__note" role="status">
          {GPS_DENIED_NOTE}
        </p>
      )}

      <div className="location-picker__bar">
        <button
          type="button"
          className="capture-btn capture-btn--secondary"
          onClick={onCancel}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="capture-btn capture-btn--secondary"
          onClick={onUseLocation}
          disabled={locating}
        >
          {locating ? "Obteniendo ubicación…" : "Usar mi ubicación"}
        </button>
        <button
          type="button"
          className="capture-btn capture-btn--primary"
          onClick={onConfirmClick}
        >
          Confirmar
        </button>
      </div>
    </div>
  );
}
