import { z } from "zod";

import {
  MediaNotFoundError,
  MediaNotReadyError,
  MediaProcessingError,
  MediaWriteError,
  UnsupportedMediaError,
  processMedia,
} from "@/lib/services/mediaService";

/**
 * POST /api/media — process an already-uploaded raw image (step07).
 *
 * Runs on the Node.js runtime (the default for Route Handlers): sharp ships a
 * native binary and the processor uses the service-role supabase-js client,
 * neither of which is Edge-compatible. Do NOT add `export const runtime =
 * "edge"`.
 *
 * Body is JSON `{ report_id, media_id }` — NOT image bytes (a 10MB image would
 * blow Vercel's ~4.5MB request-body limit). The handler validates the ids,
 * delegates to `processMedia` (download raw -> strip EXIF/GPS -> compress ->
 * overwrite + thumbnail -> mark state), and maps typed errors to status codes.
 */

const bodySchema = z.object({
  report_id: z.string().uuid(),
  media_id: z.string().uuid(),
});

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidPayload();
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return invalidPayload();
  }

  const { report_id, media_id } = parsed.data;

  try {
    const result = await processMedia({
      reportId: report_id,
      mediaId: media_id,
    });
    return Response.json(
      {
        media_id,
        processing_state: result.state,
        width: result.width,
        height: result.height,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof MediaNotFoundError) {
      return Response.json(
        { error: { code: "media_not_found", message: "Media no encontrada." } },
        { status: 404 },
      );
    }
    if (error instanceof UnsupportedMediaError) {
      return Response.json(
        {
          error: {
            code: "unsupported_media",
            message: "Tipo de media no soportado.",
          },
        },
        { status: 422 },
      );
    }
    if (error instanceof MediaProcessingError) {
      // TERMINAL: the row is already marked 'failed'; the report stays invisible.
      return Response.json(
        {
          error: {
            code: "media_processing_failed",
            message: "No se pudo procesar la imagen.",
          },
        },
        { status: 422 },
      );
    }
    if (error instanceof MediaNotReadyError) {
      // RETRYABLE: the raw object is not uploaded yet; row stays 'pending'.
      return Response.json(
        {
          error: {
            code: "media_not_ready",
            message: "La imagen aún no está disponible. Reintenta.",
          },
        },
        { status: 409 },
      );
    }
    if (error instanceof MediaWriteError) {
      // RETRYABLE: a transient storage/DB write fault; row stays 'pending'.
      return Response.json(
        {
          error: {
            code: "media_write_failed",
            message: "Error temporal al guardar. Inténtalo de nuevo.",
          },
        },
        { status: 503 },
      );
    }

    console.error("POST /api/media failed", { report_id, media_id, error });
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: "No se pudo procesar la imagen. Inténtalo de nuevo.",
        },
      },
      { status: 500 },
    );
  }
}

function invalidPayload(): Response {
  return Response.json(
    {
      error: {
        code: "invalid_payload",
        message: "Cuerpo de la petición inválido.",
      },
    },
    { status: 422 },
  );
}
