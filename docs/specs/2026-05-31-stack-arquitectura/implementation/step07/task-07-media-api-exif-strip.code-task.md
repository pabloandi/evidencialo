## Status: PENDING
## Blocked-By: step05/task-05-report-service-create-api.code-task.md
## Completed:

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
