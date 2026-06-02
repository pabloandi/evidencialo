## Status: PENDING
## Blocked-By: step07/task-07-media-api-exif-strip.code-task.md
## Completed:

# Task: Trigger de visibilidad sobre report_media.processing_state

## Description
Crear el trigger de base de datos que pone `reports.is_visible = true` solo cuando
ninguna media del reporte queda en `pending` ni `failed`. Es el único punto de
verdad de la visibilidad y cierra la condición de carrera entre el procesado de
imagen y el de video.

## Background
Imagen (`/api/media`) y video (Edge Function) procesan en paralelo. Si cualquiera
de las dos rutas decidiera la visibilidad habría un race. El trigger centraliza
la decisión y es testeable de forma aislada con pgTAP sin que exista aún la Edge
Function de video.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§5 paso 5)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 8)
- Skill: `supabase:supabase-postgres-best-practices`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. Migración `0006_visibility_trigger.sql`: trigger AFTER UPDATE sobre
   `report_media.processing_state`.
2. Lógica: marcar el reporte visible solo si no quedan filas `pending` ni `failed`.
3. Tests pgTAP que cubren las combinaciones de estados.

## Dependencies
- **Paso 07 completado**: `report_media` y su `processing_state` existen y se
  actualizan.

## Implementation Approach
1. Escribir la función del trigger que evalúa el conjunto de media del reporte.
2. Enlazarla como trigger AFTER UPDATE de `processing_state`.
3. Escribir los tests pgTAP de las combinaciones.

## Acceptance Criteria
1. **E1 (cierre) — Todo procesado → visible**
   - Given un reporte cuya media pasa toda a `processed`
   - When el trigger evalúa el reporte
   - Then `is_visible` queda en `true`.

2. **E2 — Invisible mientras haya pending**
   - Given un reporte con al menos una media en `pending`
   - When el trigger evalúa el reporte
   - Then `is_visible` permanece en `false`.

3. **E10 (parte) — Cualquier failed mantiene invisible**
   - Given un reporte con al menos una media en `failed`
   - When el trigger evalúa el reporte
   - Then `is_visible` permanece en `false`.

## Metadata
- **Complexity**: Low
- **Estimated Effort**: S
- **Labels**: database, trigger, visibility, concurrency
- **Required Skills**: Postgres triggers, pgTAP
- **Related Tasks**: step07, step09
- **Step**: 08 of 15
- **Files to Modify**: `supabase/migrations/0006_visibility_trigger.sql`, `tests/rls/visibility_trigger.sql`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: S
- **Scenario-Strategy**: required
