## Status: PENDING
## Blocked-By: step05/task-05-report-service-create-api.code-task.md
## Completed:

# Task: Mapa público por bounding box (GET /api/reports + MapView)

## Description
Implementar la lectura pública del mapa: un endpoint que devuelve reportes
visibles dentro de un bounding box usando el índice GIST de PostGIS, y el
componente `MapView` que los renderiza con MapLibre GL + tiles de MapTiler.

## Background
Las lecturas del mapa se cachean (no pasan por la lógica de escritura). Solo se
exponen reportes `is_visible=true`. MapLibre + MapTiler evita la facturación de
Google Maps en una vista pública abierta.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§2, §4 índices)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 11)
- Skills: `vercel-plugin:nextjs`, `frontend-design:frontend-design`

**Note:** You MUST read the detailed design before implementing. Verifica la API
de MapLibre GL y MapTiler en docs vigentes.

## Technical Requirements
1. `lib/geo.ts`: helpers de bounding box / consulta PostGIS.
2. `app/api/reports/route.ts` (GET): filtra por bbox con índice GIST; solo
   `is_visible=true`.
3. `components/map/MapView.tsx`: render con MapLibre GL + MapTiler.
4. `app/(public)/page.tsx`: página del mapa (RSC, cacheada).

## Dependencies
- **Paso 05 completado**: existen reportes y el handler de `/api/reports`.

## Implementation Approach
1. Implementar la consulta por bbox con PostGIS/GIST en `geo` + service.
2. Añadir el método GET al handler de reportes.
3. Implementar `MapView` y la página pública del mapa.

## Acceptance Criteria
1. **E8 — Consulta por bounding box**
   - Given reportes visibles en distintas coordenadas
   - When el mapa pide reportes para un bbox
   - Then solo devuelve los visibles dentro de ese recuadro.

2. **E2 — Excluye no visibles**
   - Given un reporte `is_visible=false` dentro del bbox
   - When se consulta el mapa
   - Then ese reporte no aparece.

3. **Render del mapa**
   - Given reportes visibles devueltos por la API
   - When se carga la página pública
   - Then el mapa pinta sus marcadores sin errores de consola.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: read-path, map, postgis, frontend, public
- **Required Skills**: PostGIS, MapLibre GL, Next.js RSC
- **Related Tasks**: step12 (detalle)
- **Step**: 11 of 15
- **Files to Modify**: `src/lib/geo.ts`, `src/app/api/reports/route.ts`, `src/components/map/MapView.tsx`, `src/app/(public)/page.tsx`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
