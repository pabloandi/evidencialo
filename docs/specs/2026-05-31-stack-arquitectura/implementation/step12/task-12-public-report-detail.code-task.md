## Status: PENDING
## Blocked-By: step11/task-11-public-map-bbox.code-task.md
## Completed:

# Task: Página de detalle de reporte (pública)

## Description
Implementar la página pública de detalle de un reporte: muestra su media
procesada, categoría, estado y fecha. Un reporte no visible no debe ser accesible
(404).

## Background
Complementa el mapa público; al pinchar un marcador se llega aquí. Solo se
muestran reportes visibles (con media ya saneada).

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§2, §4)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 12)
- Skills: `vercel-plugin:nextjs`, `frontend-design:frontend-design`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. `app/(public)/reportes/[id]/page.tsx`: detalle con media, categoría, estado,
   fecha.
2. Reporte no visible → respuesta 404.
3. Lectura cacheada (RSC).

## Dependencies
- **Paso 11 completado**: la lectura de reportes y el mapa existen.

## Implementation Approach
1. Implementar la carga del reporte por id (solo visible).
2. Renderizar el detalle con su media saneada.
3. Devolver 404 para reportes no visibles.

## Acceptance Criteria
1. **Detalle de reporte visible**
   - Given un reporte visible
   - When se abre su página de detalle
   - Then muestra estado, categoría, fecha y media saneada.

2. **No visible → 404**
   - Given un reporte `is_visible=false`
   - When se intenta abrir su detalle
   - Then la página responde 404 (no accesible).

3. **Media saneada**
   - Given el detalle de un reporte
   - When se inspecciona la media mostrada
   - Then corresponde a la versión procesada (sin EXIF/metadatos de localización).

## Metadata
- **Complexity**: Low
- **Estimated Effort**: S
- **Labels**: read-path, frontend, public, detail
- **Required Skills**: Next.js RSC, Supabase
- **Related Tasks**: step11
- **Step**: 12 of 15
- **Files to Modify**: `src/app/(public)/reportes/[id]/page.tsx`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: S
- **Scenario-Strategy**: required
