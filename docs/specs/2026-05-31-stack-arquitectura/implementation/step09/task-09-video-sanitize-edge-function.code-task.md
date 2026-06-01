## Status: PENDING
## Blocked-By: step08/task-08-visibility-trigger.code-task.md
## Completed:

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
