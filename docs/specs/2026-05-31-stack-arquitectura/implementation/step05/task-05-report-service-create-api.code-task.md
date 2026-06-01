## Status: PENDING
## Blocked-By: step03/task-03-data-model-rls-role-hook.code-task.md
## Completed:

# Task: reportService + POST /api/reports (validación, límites, idempotencia)

## Description
Implementar el servicio de dominio de reportes y el Route Handler de creación.
Valida el payload (categoría, coordenadas, descripción y límites de media),
aplica una clave de idempotencia, crea el reporte invisible y devuelve las URLs
firmadas de subida.

## Background
La frontera de escritura del enfoque híbrido. Aquí se concentran validación y la
creación del reporte (`is_visible=false`). Los reintentos por red no deben crear
reportes duplicados (idempotencia). Los límites de media acotan coste y abuso.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§5 Flujo de envío, §6)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 5)
- Skills: `vercel-plugin:vercel-functions`, `supabase:supabase`

**Note:** You MUST read the detailed design before implementing. Verifica la API
de Route Handlers y Storage signed URLs en docs vigentes.

## Technical Requirements
1. `lib/validation/reportSchema.ts` (zod): categoría válida, coordenadas en rango,
   longitud de descripción, y límites de media (formatos, tamaño, cantidad).
2. `lib/services/reportService.ts` con `create` (idempotente por clave).
3. `app/api/reports/route.ts` (POST): valida, crea `reports` con
   `is_visible=false`, devuelve `report_id` y URL(s) firmada(s).

## Dependencies
- **Paso 03 completado**: tablas y RLS existen.

## Implementation Approach
1. Definir el schema de validación con los límites de media.
2. Implementar `reportService.create` con manejo de clave de idempotencia.
3. Implementar el Route Handler POST y la emisión de URLs firmadas.

## Acceptance Criteria
1. **E11 — Reintento idempotente no duplica**
   - Given un cliente que reintenta POST con la misma clave de idempotencia tras
     un fallo de red
   - When la API recibe el segundo intento
   - Then no crea un reporte duplicado y devuelve el ya creado.

2. **Límites de media rechazados**
   - Given un payload que excede los límites (formato/tamaño/cantidad)
   - When se envía a `/api/reports`
   - Then la API responde 4xx con mensaje estructurado y no crea el reporte.

3. **Reporte nace invisible**
   - Given un envío válido
   - When se crea el reporte
   - Then queda con `is_visible=false` y la respuesta incluye URL(s) firmada(s).

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: api, write-path, validation, idempotency
- **Required Skills**: Next.js Route Handlers, zod, Supabase
- **Related Tasks**: step06, step07, step11
- **Step**: 05 of 15
- **Files to Modify**: `src/lib/validation/reportSchema.ts`, `src/lib/services/reportService.ts`, `src/app/api/reports/route.ts`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
