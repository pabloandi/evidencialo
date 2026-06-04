## Status: DONE
## Blocked-By: step08/task-08-visibility-trigger.code-task.md
## Completed:

<!--
PROGRESO (2026-06-03):
DONE y verificado:
- Holdout SDD: docs/specs/.../scenarios/video-sanitize.scenarios.md (SCEN-001..005).
- supabase/functions/sanitize-video/: index.ts (Deno.serve, service-role) +
  mp4.ts (stripMp4Metadata portable) + retry.ts (withRetry backoff) + tests vitest.
- Saneo: reescritor de cajas ISO-BMFF que RE-TIPA a `free` (size-preserving) las
  cajas moov/udta y moov/meta (donde vive el GPS ©xyz). NO transcodifica, NO mueve
  mdat → offsets stco/co64 intactos → video reproducible, metadata fuera. ffmpeg
  NO está en el runtime Edge; el box-rewrite en Deno puro cabe en los límites.
- Máquina de estados (reusa taxonomía step07): parse/corrupto → failed TERMINAL
  (422); I/O transitoria → withRetry(3, backoff) → failed (503) al agotar; ya
  processed → 200 idempotente. Marca processed/failed; el trigger step08 publica.
- config.toml [functions.sanitize-video] verify_jwt=false (procesador interno por
  UUID, mismo posture que /api/media). tsconfig excluye supabase/functions de tsc;
  vitest.config incluye supabase/functions/**/*.test.ts. mediaService.ts SIN tocar
  (el cliente invoca la función directo; procesadores independientes).
- Tests: vitest 110 (mp4 4 con ffmpeg/ffprobe reales + retry 4). pgTAP 29 (sin
  regresión). lint/typecheck/build exit 0.
- E2E (función servida + Storage/DB local): mp4 con location=+40/-074 → objeto
  saneado location='' + stream de video intacto + processed + is_visible=true;
  re-invoke idempotente count=1; corrupto → failed + is_visible=false.

ACEPTACIÓN:
- AC1 (E1 cierre — video processed publica): SATISFECHO (E2E, is_visible=true).
- AC2 (E10 — falla persistente → failed, nunca visible + registrado): SATISFECHO
  (E2E corrupto → failed/invisible/422 logueado).
- AC3 (saneo elimina metadatos): SATISFECHO + probado con ffprobe sobre el objeto
  REAL almacenado (no vacuo: el input tenía location).

NOTA: el lock de concurrencia del trigger step08 ya cubre a este SEGUNDO writer
de processing_state (imagen /api/media + video).

ACCIÓN PENDIENTE DEL USUARIO:
- (Hecho por mí vía MCP) Deploy al remoto: la función no necesita secrets extra
  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY auto-inyectadas).
-->

# Task: Video — URL firmada + Edge Function de saneado (backoff, failed)

## Description
Permitir la subida de video por URL firmada directa a Storage y procesarlo con
una Supabase Edge Function que sanea los metadatos del contenedor, reintenta con
backoff y marca la media como `processed` o `failed`. El paso a visible lo decide
el trigger del Paso 8.

## Background
El video es el activo más pesado; se sube por URL firmada en lugar de a través de
la API. El saneado de metadatos protege PII. Si el saneado agota reintentos, la
media queda `failed` y el reporte nunca se publica.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§5 paso 4, §6)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 9)
- Skill: `supabase:supabase`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. `supabase/functions/sanitize-video/index.ts`: sanea metadatos del contenedor.
2. Reintentos con backoff; al agotarlos, marca `processing_state = failed` y
   registra el error para revisión en el panel.
3. Al éxito, marca `processing_state = processed` (el trigger del Paso 8 hace el
   resto).

## Dependencies
- **Paso 08 completado**: el trigger de visibilidad existe y reacciona a
  `processing_state`.

## Implementation Approach
1. Implementar la subida de video por URL firmada.
2. Implementar la Edge Function de saneado con backoff.
3. Marcar `processed`/`failed` y registrar fallos persistentes.

## Acceptance Criteria
1. **E1 (cierre) — Video procesado publica el reporte**
   - Given un reporte cuyo único pendiente es un video
   - When la Edge Function sanea el video y lo marca `processed`
   - Then el reporte pasa a visible (vía el trigger).

2. **E10 — Video que falla nunca se publica**
   - Given un video cuyo saneado agota los reintentos
   - When queda en `processing_state = failed`
   - Then el reporte permanece `is_visible=false` y el fallo queda registrado.

3. **Saneado elimina metadatos**
   - Given un video con metadatos de localización en el contenedor
   - When la función lo procesa con éxito
   - Then el objeto resultante no expone esos metadatos.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: media, video, edge-function, privacy, write-path
- **Required Skills**: Supabase Edge Functions, video metadata handling
- **Related Tasks**: step07, step08, step10
- **Step**: 09 of 15
- **Files to Modify**: `supabase/functions/sanitize-video/index.ts`, `src/lib/services/mediaService.ts`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
