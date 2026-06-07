import { Capacitor } from "@capacitor/core";

/**
 * Framework-light capture abstraction (step15 — SCEN-003).
 *
 * One return shape, two implementations chosen at runtime by
 * `Capacitor.isNativePlatform()`:
 * - On a device (native), photos and GPS come from the `@capacitor/camera` /
 *   `@capacitor/geolocation` plugins.
 * - In a browser (web), GPS comes from `navigator.geolocation`; the photo comes
 *   from a `<input type="file" capture>` owned by the form (so `capturePhotoNative`
 *   is the NATIVE branch only — the web path never calls it).
 *
 * The native plugins are loaded via dynamic `import()` so they are not pulled
 * into the web bundle and only resolve on device. Errors are typed
 * (`CaptureError`) so the UI can show a precise Spanish message.
 */

export type Coordinates = { lat: number; lng: number };

export type CaptureErrorCode =
  | "permission_denied"
  | "position_unavailable"
  | "timeout"
  | "capture_failed"
  | "unsupported";

/** A typed capture failure with a stable code the UI maps to a Spanish message. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

/** Whether the app runs inside a Capacitor native shell (Android/iOS). */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Resolve the current position as `{ lat, lng }`.
 *
 * Native: `Geolocation.getCurrentPosition()`. Web: `navigator.geolocation`
 * wrapped in a Promise. Both reject with a `CaptureError` on permission denial
 * or when a fix is unavailable.
 */
export async function getPosition(): Promise<Coordinates> {
  if (isNative()) {
    return getPositionNative();
  }
  return getPositionWeb();
}

async function getPositionNative(): Promise<Coordinates> {
  const { Geolocation } = await import("@capacitor/geolocation");
  try {
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
    });
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
    };
  } catch (error) {
    throw mapGeolocationError(error);
  }
}

function getPositionWeb(): Promise<Coordinates> {
  return new Promise<Coordinates>((resolve, reject) => {
    if (
      typeof navigator === "undefined" ||
      !("geolocation" in navigator) ||
      !navigator.geolocation
    ) {
      reject(
        new CaptureError(
          "unsupported",
          "Este navegador no permite obtener tu ubicación.",
        ),
      );
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      (error) => {
        reject(mapGeolocationError(error));
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

/**
 * Capture a photo from the device camera — NATIVE branch ONLY.
 *
 * The web path uses the form's `<input type="file">`, so this is never called in
 * a browser. Returns a `File` (JPEG) so the submit path is identical to the web
 * file-input path. Uses `CameraResultType.Uri` and fetches the `webPath` blob,
 * which avoids holding a large base64 string in memory.
 */
export async function capturePhotoNative(): Promise<File> {
  const { Camera, CameraResultType, CameraSource } = await import(
    "@capacitor/camera"
  );

  let photo;
  try {
    photo = await Camera.getPhoto({
      quality: 80,
      resultType: CameraResultType.Uri,
      source: CameraSource.Camera,
      correctOrientation: true,
    });
  } catch (error) {
    throw new CaptureError(
      "capture_failed",
      error instanceof Error && /denied|permission/i.test(error.message)
        ? "Permiso de cámara denegado."
        : "No se pudo tomar la foto. Inténtalo de nuevo.",
    );
  }

  if (!photo.webPath) {
    throw new CaptureError("capture_failed", "No se pudo leer la foto tomada.");
  }

  const response = await fetch(photo.webPath);
  const blob = await response.blob();
  const format = photo.format || "jpeg";
  const mime = blob.type || `image/${format}`;
  return new File([blob], `captura.${format}`, { type: mime });
}

/**
 * Normalize a geolocation failure (web `GeolocationPositionError` codes 1/2/3
 * or a Capacitor error) into a typed `CaptureError`.
 */
function mapGeolocationError(error: unknown): CaptureError {
  // Web GeolocationPositionError: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT.
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: number }).code
      : undefined;

  if (code === 1) {
    return new CaptureError(
      "permission_denied",
      "Permiso de ubicación denegado. Actívalo para reportar.",
    );
  }
  if (code === 3) {
    return new CaptureError(
      "timeout",
      "No se pudo obtener tu ubicación a tiempo. Inténtalo de nuevo.",
    );
  }

  // Capacitor surfaces permission denials as a message rather than a numeric code.
  if (error instanceof Error && /denied|permission/i.test(error.message)) {
    return new CaptureError(
      "permission_denied",
      "Permiso de ubicación denegado. Actívalo para reportar.",
    );
  }

  return new CaptureError(
    "position_unavailable",
    "No se pudo obtener tu ubicación. Inténtalo de nuevo.",
  );
}
