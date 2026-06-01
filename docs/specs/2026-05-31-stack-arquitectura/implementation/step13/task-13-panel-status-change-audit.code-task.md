## Status: PENDING
## Blocked-By: step04/task-04-auth-roles-panel-gate.code-task.md
## Completed:

# Task: Panel — lista/filtros + cambio de estado + auditoría

## Description
Implementar el panel de gestión municipal: lista de reportes con filtros por
estado y categoría, y el endpoint de cambio de estado que verifica rol, actualiza
el estado, escribe en el historial de auditoría y fija `resolved_at` al resolver.

## Background
Superficie interna del personal. El cambio de estado debe quedar auditado
(`report_status_history`) y solo lo puede hacer staff/admin. La autorización vive
en el servidor (`authz`), con RLS como respaldo.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§5 cambio de estado)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 13)
- Skills: `vercel-plugin:nextjs`, `frontend-design:frontend-design`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. `app/(panel)/page.tsx`: lista con filtros por estado/categoría.
2. `app/api/reports/[id]/status/route.ts` (POST): verifica rol, actualiza estado,
   inserta en `report_status_history`, fija `resolved_at` si pasa a `resuelto`.
3. `components/panel/StatusControl.tsx`: control de cambio de estado.

## Dependencies
- **Paso 04 completado**: auth, roles y gate de panel existen.

## Implementation Approach
1. Implementar la lista con filtros (lectura para staff).
2. Implementar el endpoint de cambio de estado con autorización y auditoría.
3. Implementar el control de estado en la UI del panel.

## Acceptance Criteria
1. **E3 — Solo staff cambia estado**
   - Given un usuario `citizen` autenticado
   - When intenta `POST /api/reports/[id]/status`
   - Then la API responde 403 y el estado no cambia.

2. **E4 — Cambio auditado**
   - Given un usuario `staff`
   - When cambia un reporte de `nuevo` a `en_proceso` con una nota
   - Then se actualiza `reports.status` y se inserta una fila en
     `report_status_history` con `from_status`, `to_status`, `changed_by` y la nota.

3. **E7 — Resolver fija resolved_at**
   - Given un reporte en `en_proceso`
   - When un staff lo pasa a `resuelto`
   - Then `resolved_at` queda con la marca temporal del cambio.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: panel, write-path, authz, audit, frontend
- **Required Skills**: Next.js, Supabase, authz
- **Related Tasks**: step04, step14
- **Step**: 13 of 15
- **Files to Modify**: `src/app/(panel)/page.tsx`, `src/app/api/reports/[id]/status/route.ts`, `src/components/panel/StatusControl.tsx`, `src/lib/services/reportService.ts`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
