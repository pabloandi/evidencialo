## Status: PENDING
## Blocked-By: step04/task-04-auth-roles-panel-gate.code-task.md
## Completed:

# Task: Vista "mis reportes" del ciudadano

## Description
Implementar la vista donde un ciudadano autenticado ve sus propios reportes y su
estado, incluidos los que aún no son visibles públicamente.

## Background
La cuenta es opcional, pero quien la tiene puede seguir sus reportes. Las
políticas RLS (Paso 3) ya permiten que el ciudadano lea los suyos aunque no sean
públicos; esta vista los presenta.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§4 RLS lectura propia)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 14)
- Skills: `vercel-plugin:nextjs`, `frontend-design:frontend-design`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. `app/(account)/mis-reportes/page.tsx`: lista los reportes del usuario y su
   estado, incluidos los `is_visible=false`.
2. Acceso restringido a usuarios autenticados.

## Dependencies
- **Paso 04 completado**: auth y sesión existen.

## Implementation Approach
1. Cargar los reportes del usuario autenticado (RLS lectura propia).
2. Renderizar la lista con estado, incluidos los no visibles.

## Acceptance Criteria
1. **E5 — Ciudadano sigue los suyos**
   - Given un ciudadano autenticado con un reporte propio no visible
   - When abre "mis reportes"
   - Then ve el reporte y su estado actual, aunque no sea público.

2. **No ve los de otros**
   - Given otros reportes de otros usuarios
   - When el ciudadano abre "mis reportes"
   - Then no aparecen reportes ajenos.

3. **Requiere sesión**
   - Given un visitante sin sesión
   - When intenta acceder a "mis reportes"
   - Then no obtiene la vista (redirige a login).

## Metadata
- **Complexity**: Low
- **Estimated Effort**: S
- **Labels**: account, read-path, frontend, citizen
- **Required Skills**: Next.js, Supabase Auth, RLS
- **Related Tasks**: step04
- **Step**: 14 of 15
- **Files to Modify**: `src/app/(account)/mis-reportes/page.tsx`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: S
- **Scenario-Strategy**: required
