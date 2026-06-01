## Status: PENDING
## Blocked-By: step09/task-09-video-sanitize-edge-function.code-task.md
## Completed:

# Task: Cron de limpieza de reportes huérfanos

## Description
Implementar un job programado (Vercel Cron) que elimina reportes invisibles cuya
media sigue sin procesar tras 24 h, junto con sus objetos parciales en Storage.
Evita la acumulación de envíos abandonados.

## Background
Un reporte se crea invisible antes de subir la media. Si el cliente nunca
completa la subida, la fila y los objetos parciales persistirían. El cron los
recoge.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§5 caminos de fallo)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 10)
- Skill: `vercel-plugin:cron-jobs`

**Note:** You MUST read the detailed design before implementing. Verifica la
configuración de Vercel Cron en `vercel.json` en docs vigentes.

## Technical Requirements
1. `app/api/cron/cleanup/route.ts` (GET): borra reportes `is_visible=false` con
   media `pending` con antigüedad > 24 h y sus objetos en Storage.
2. Declaración del cron en `vercel.json`.
3. El umbral de tiempo debe ser inyectable para poder testear con un reloj fijo.

## Dependencies
- **Paso 09 completado**: el pipeline de media existe (define qué es huérfano).

## Implementation Approach
1. Implementar la consulta de reportes huérfanos por antigüedad.
2. Borrar filas y objetos de Storage asociados.
3. Declarar el cron en `vercel.json` e inyectar el reloj para tests.

## Acceptance Criteria
1. **E9 — Huérfano > 24 h se limpia**
   - Given un reporte `is_visible=false` con media `pending` desde hace > 24 h
   - When corre el job de limpieza
   - Then el reporte y sus objetos parciales en Storage se eliminan.

2. **No borra reportes recientes**
   - Given un reporte huérfano de 1 h
   - When corre el job
   - Then ese reporte NO se elimina.

3. **No toca reportes visibles**
   - Given un reporte visible
   - When corre el job
   - Then ese reporte permanece intacto.

## Metadata
- **Complexity**: Low
- **Estimated Effort**: S
- **Labels**: cron, cleanup, storage, maintenance
- **Required Skills**: Vercel Cron, Next.js Route Handlers, Supabase
- **Related Tasks**: step09
- **Step**: 10 of 15
- **Files to Modify**: `src/app/api/cron/cleanup/route.ts`, `vercel.json`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: S
- **Scenario-Strategy**: required
