## Status: DONE
## Blocked-By: step09/task-09-video-sanitize-edge-function.code-task.md
## Completed:

<!--
PROGRESO (2026-06-03):
DONE y verificado:
- Holdout SDD: orphan-cleanup.scenarios.md (SCEN-001..005) +
  orphan-cleanup-hardening.scenarios.md (SCEN-H01 bounded/oldest-first, H02 zero-media).
- src/lib/services/cleanupService.ts: cleanupOrphans({now,cutoffHours=24,batchLimit=200},
  client?) → llama la RPC find_orphan_reports (acotada + oldest-first), pagina
  storage.list, borra objetos (concurrencia acotada) + batch delete .in(ids)
  (cascade), devuelve {deletedReportIds, storageResidueReportIds}. Reloj inyectable.
- src/app/api/cron/cleanup/route.ts: gate CRON_SECRET (fail-closed 401), runtime
  nodejs + maxDuration 60, responde {deleted, storageResidue}.
- Migración 0008_orphan_cleanup.sql: índice parcial report_media_pending_idx +
  find_orphan_reports(timestamptz,int) SECURITY DEFINER (search_path='', execute
  solo a service_role). Selecciona invisible + >cutoff + (pending media O sin media);
  failed-only se conserva.
- vercel.json: cron ya declarado (/api/cron/cleanup, 0 3 * * *).
- CI: db.yml ahora corre los *.integration.test.ts (arbiters de steps 05-10) contra
  el stack local — antes se auto-saltaban en CI.
- Tests: vitest 125. pgTAP 29 (sin regresión). Integración (DB+Storage real) cubre
  SCEN-001..004 + H01 (drain ordenado) + H02 (zero-media). lint/typecheck/build 0.
- Aplicado al remoto (0008) + advisor.
- Quality gate: security limpio (borrado catastrófico por IN-vacío doblemente
  defendido + auth fail-closed), code-review aprobó. Fixes edge/perf: CRÍTICO cap
  silencioso de 1000 filas / loop sin cota → RPC acotada+ordenada + batch delete;
  paginación de storage.list (>100 objetos); zero-media arm; índice parcial;
  residue observability; runtime/maxDuration explícitos; integración en CI.

ACEPTACIÓN:
- AC1 (E9 — huérfano >24h se limpia + objetos Storage): SATISFECHO (integración).
- AC2 (no borra recientes): SATISFECHO (SCEN-002).
- AC3 (no toca visibles): SATISFECHO (SCEN-003).

ACCIÓN PENDIENTE DEL USUARIO:
- Setear CRON_SECRET en Vercel env (Vercel manda el bearer solo). Sin ella el
  endpoint cae a 401 (fail-closed).
-->

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
