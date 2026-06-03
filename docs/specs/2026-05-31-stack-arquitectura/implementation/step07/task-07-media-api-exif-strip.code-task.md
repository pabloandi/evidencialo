## Status: DONE
## Blocked-By: step05/task-05-report-service-create-api.code-task.md
## Completed:

<!--
PROGRESO (2026-06-02):
DONE y verificado:
- Holdout SDD: docs/specs/.../scenarios/media-process.scenarios.md (SCEN-001..007)
  + media-process-hardening.scenarios.md (SCEN-H01..H04).
- src/lib/exif.ts: processImage(raw) con sharp — decode ÚNICO + clone para full y
  thumbnail (encode en paralelo); limitInputPixels=50MP (anti decompression-bomb);
  full reescalado a 2048px; re-encode PRESERVANDO formato de entrada (jpeg/png/
  webp) con content-type acorde; thumbnail webp ≤400 en path derivado. EXIF/GPS
  se elimina por defecto (toBuffer no preserva metadata). sharp.concurrency(1)+
  cache(false) para memoria serverless.
- src/lib/services/mediaService.ts: processMedia({reportId, mediaId}). Taxonomía
  de errores: NotFound(404), Unsupported(422), NotReady(409, queda pending),
  Decode/bomb/>10MB → markFailed terminal(422), WriteError(503, queda pending,
  retryable). Uploads en Promise.all; update final guardado por pending; markFailed
  inspecciona el {error} de supabase. Short-circuit idempotente si processed.
- src/app/api/media/route.ts: mapea los 5 errores + 200.
- Tests: vitest 108 (exif, mediaService, route + integración local: GPS-strip
  contra objeto real, formato webp preservado, not-ready, retryable, corrupto→
  failed+invisible). lint/typecheck/build exit 0.
- Quality gate: 4 agentes. code-review APROBÓ; security LIMPIO (privacidad
  garantizada). Fixes de edge-case/performance: (A) limitInputPixels+recheck de
  bytes; (B) decode único + uploads paralelos; (C) resize 2048; (D) decode-error
  terminal vs write-error retryable; (E) formato preservado; (F) markFailed
  chequea {error}; (H) guard de auto-colisión de thumbnailPath.

DESVIACIÓN de diseño (documentada, consistente con §5.3 actualizado en step05):
- /api/media NO recibe bytes — recibe {report_id, media_id} y PROCESA el objeto
  raw que el cliente subió por signed URL al bucket privado. Lee→limpia EXIF→
  comprime→thumbnail→sobrescribe el raw→marca processed. El raw-con-EXIF vive en
  bucket privado y is_visible=false hasta que el trigger de step08 (0007) lo
  publique; nada público lleva EXIF.

DIFERIDO (documentado, no silenciado):
- Claim de concurrencia completo (estado 'processing') → necesita valor de enum
  → se diseña con el trigger de visibilidad (step08). Mitigación parcial: update
  final guardado por pending (segundo escritor concurrente = no-op). El output es
  determinista + upsert → sin corrupción, solo doble trabajo raro bajo overlap.
- Gating de auth/rate-limit en /api/media → UUIDs no adivinables + idempotente;
  revisar si se quiere endurecer.

ACEPTACIÓN:
- AC1 (E1 parcial — imagen sin EXIF): SATISFECHO + verificado contra storage real
  (objeto descargado sin GPS; el fixture SÍ tenía GPS — no vacuo).
- AC2 (subida idempotente no duplica): SATISFECHO (processMedia hace UPDATE, no
  INSERT; count=1 tras reintento).
- AC3 (processing_state=processed): SATISFECHO + integración.

ACCIÓN PENDIENTE DEL USUARIO:
- sharp es dependencia de PRODUCCIÓN (Vercel la bundlea en runtime Node). Sin envs
  nuevas más allá de las existentes (SUPABASE_SERVICE_ROLE_KEY).
-->

# Task: POST /api/media — subida de imagen con strip de EXIF + thumbnail

## Description
Implementar el servicio de media y el Route Handler que recibe imágenes a través
del servidor, elimina el EXIF (la geolocalización incrustada es PII), comprime,
genera thumbnail, guarda en Storage con service-role y actualiza el estado de
procesado de la media.

## Background
Las imágenes se suben a través de la API (no por URL firmada directa) justamente
para poder eliminar EXIF antes de que la media sea pública. La subida es
idempotente por `report_id` + índice de archivo para tolerar reintentos.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§5 paso 3, §6)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 7)
- Skills: `vercel-plugin:vercel-functions`, `supabase:supabase`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. `lib/exif.ts`: elimina metadatos EXIF (incluida geolocalización) de imágenes.
2. `lib/services/mediaService.ts`: procesa (strip, compresión, thumbnail),
   guarda en Storage con service-role y marca `processing_state`.
3. `app/api/media/route.ts` (POST): recibe la imagen, procesa, persiste; subida
   idempotente por `report_id` + índice de archivo.

## Dependencies
- **Paso 05 completado**: el reporte y la emisión de URLs existen.

## Implementation Approach
1. Implementar el strip de EXIF y la generación de thumbnail.
2. Implementar `mediaService` con persistencia en Storage (service-role).
3. Implementar el Route Handler POST con idempotencia.

## Acceptance Criteria
1. **E1 (parcial) — Imagen almacenada sin EXIF**
   - Given una imagen con EXIF de geolocalización
   - When se sube por `/api/media`
   - Then el objeto almacenado no contiene EXIF de localización.

2. **Subida idempotente no duplica media**
   - Given una subida que se reintenta con el mismo `report_id` + índice de archivo
   - When la API recibe el reintento
   - Then no crea media duplicada.

3. **Estado de procesado actualizado**
   - Given una imagen procesada con éxito
   - When termina el handler
   - Then su `processing_state` queda en `processed`.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: api, media, exif, privacy, storage, write-path
- **Required Skills**: Next.js Route Handlers, image processing, Supabase Storage
- **Related Tasks**: step08 (trigger), step09 (video), step15 (Android)
- **Step**: 07 of 15
- **Files to Modify**: `src/lib/exif.ts`, `src/lib/services/mediaService.ts`, `src/app/api/media/route.ts`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
