import { z } from "zod";

/**
 * Input validation for the report-create write path (step05).
 *
 * Parses the untrusted request body structurally with zod, then applies
 * explicit business rules IN ORDER so the FIRST violation maps to the exact
 * error code + Spanish message the scenarios pin (see
 * `report-create.scenarios.md`). Scenarios expect a single `error` object, not
 * an array, so we short-circuit on the first failure.
 *
 * Category EXISTENCE is NOT checked here — only that it is a non-empty string.
 * The service resolves the slug against `categories` and raises
 * `CategoryInvalidError` (SCEN-007) so this module stays free of I/O.
 */

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIME = "video/mp4";

const MAX_IMAGES = 3;
const MAX_VIDEOS = 1;
const MAX_IMAGE_BYTES = 10_000_000; // 10 MB
const MAX_VIDEO_BYTES = 50_000_000; // 50 MB
const MAX_VIDEO_DURATION_S = 60;
const MAX_DESCRIPTION_CHARS = 2000;

export type ValidMediaInput = {
  type: "image" | "video";
  mime: string;
  size: number;
  duration_s?: number;
};

export type ValidReportInput = {
  category: string;
  lat: number;
  lng: number;
  description?: string;
  media: ValidMediaInput[];
};

export type ValidationError = {
  code: string;
  message: string;
  field?: string;
};

export type ValidationResult =
  | { ok: true; value: ValidReportInput }
  | { ok: false; error: ValidationError };

// Structural shape only. Business limits (sizes, counts, ranges) are enforced
// afterward in a fixed order so error codes/messages are deterministic.
//
// Numeric hardening (SCEN-011): `size` must be a positive integer (bytes),
// `duration_s` a non-negative integer (seconds). This rejects 0, negatives,
// fractions, NaN and Infinity at the structural layer — yielding a 422
// `invalid_payload` instead of letting a bad number reach Postgres and surface
// as a 500. `.finite()` on coordinates is belt-and-suspenders: `z.number()`
// already rejects NaN/Infinity, but the explicit guard documents intent.
const mediaItemSchema = z.object({
  type: z.enum(["image", "video"]),
  mime: z.string(),
  size: z.number().int().positive(),
  duration_s: z.number().int().nonnegative().optional(),
});

const reportSchema = z.object({
  category: z.string(),
  lat: z.number().finite(),
  lng: z.number().finite(),
  description: z.string().optional(),
  media: z.array(mediaItemSchema),
});

function fail(error: ValidationError): ValidationResult {
  return { ok: false, error };
}

export function validateReportInput(raw: unknown): ValidationResult {
  // Structural parse: not an object / missing fields / wrong types -> 422.
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? first.path.join(".") : undefined;
    return fail({
      code: "invalid_payload",
      message: "Cuerpo de la petición inválido.",
      field,
    });
  }

  const value = parsed.data;

  // category: must be a non-empty string (existence checked in the service).
  if (value.category.trim().length === 0) {
    return fail({
      code: "category_required",
      message: "La categoría es obligatoria.",
      field: "category",
    });
  }

  // coordinates: lat in [-90,90], lng in [-180,180].
  if (value.lat < -90 || value.lat > 90) {
    return fail({
      code: "coordinates_out_of_range",
      message: "Coordenadas fuera de rango.",
      field: "lat",
    });
  }
  if (value.lng < -180 || value.lng > 180) {
    return fail({
      code: "coordinates_out_of_range",
      message: "Coordenadas fuera de rango.",
      field: "lng",
    });
  }

  // description: optional, max length.
  if (
    value.description !== undefined &&
    value.description.length > MAX_DESCRIPTION_CHARS
  ) {
    return fail({
      code: "description_too_long",
      message: "La descripción supera los 2000 caracteres.",
      field: "description",
    });
  }

  // media: at least one item.
  if (value.media.length === 0) {
    return fail({
      code: "media_required",
      message: "Adjunta al menos una foto o video.",
      field: "media",
    });
  }

  const imageCount = value.media.filter((m) => m.type === "image").length;
  const videoCount = value.media.filter((m) => m.type === "video").length;

  if (imageCount > MAX_IMAGES) {
    return fail({
      code: "too_many_images",
      message: "Máximo 3 imágenes por reporte.",
      field: "media",
    });
  }
  if (videoCount > MAX_VIDEOS) {
    return fail({
      code: "too_many_videos",
      message: "Máximo 1 video por reporte.",
      field: "media",
    });
  }

  // Per-item checks, in index order. mime first, then size, then duration.
  for (let i = 0; i < value.media.length; i++) {
    const item = value.media[i];
    if (item.type === "image") {
      if (!IMAGE_MIMES.has(item.mime)) {
        return fail({
          code: "media_format_invalid",
          message: "Formato de imagen no permitido. Usa JPEG, PNG o WebP.",
          field: `media.${i}.mime`,
        });
      }
      if (item.size > MAX_IMAGE_BYTES) {
        return fail({
          code: "media_too_large",
          message: "La imagen supera el tamaño máximo de 10 MB.",
          field: `media.${i}.size`,
        });
      }
    } else {
      if (item.mime !== VIDEO_MIME) {
        return fail({
          code: "media_format_invalid",
          message: "Formato de video no permitido. Usa MP4.",
          field: `media.${i}.mime`,
        });
      }
      if (item.size > MAX_VIDEO_BYTES) {
        return fail({
          code: "media_too_large",
          message: "El video supera el tamaño máximo de 50 MB.",
          field: `media.${i}.size`,
        });
      }
      if (
        item.duration_s !== undefined &&
        item.duration_s > MAX_VIDEO_DURATION_S
      ) {
        return fail({
          code: "video_too_long",
          message: "El video supera la duración máxima de 60 segundos.",
          field: `media.${i}.duration_s`,
        });
      }
    }
  }

  return { ok: true, value };
}
