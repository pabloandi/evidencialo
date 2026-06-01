## Status: PENDING
## Blocked-By: step03/task-03-data-model-rls-role-hook.code-task.md
## Completed:

# Task: Auth (ciudadano opcional + roles staff) + gate de panel

## Description
Configurar Supabase Auth con registro/login opcional para el ciudadano y
asignación de rol staff. Implementar `authz` para resolver el rol desde el claim
del JWT y proteger el grupo de rutas del panel, redirigiendo a quien no sea staff.
El cambio de rol debe forzar refresh de sesión para no evaluar un claim obsoleto.

## Background
La identidad ciudadana es opcional (anónimo permitido); la cuenta habilita
seguimiento y avisos. El personal municipal tiene cuentas con rol. El rol se
expone como claim del JWT (Paso 3) y `authz` lo lee para autorizar.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§1, §4)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 4)
- Skills: `supabase:supabase`, `vercel-plugin:auth`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. Supabase Auth integrado (clientes server/browser en `lib/supabase/`).
2. Registro/login opcional para ciudadano; mecanismo para asignar rol staff.
3. `lib/services/authz.ts` resuelve rol desde el claim y expone helpers de
   autorización.
4. `app/(panel)/layout.tsx` redirige si el usuario no es staff/admin.
5. El cambio de rol fuerza refresh de sesión.

## Dependencies
- **Paso 03 completado**: tablas, RLS y claim de rol existen.

## Implementation Approach
1. Configurar los clientes Supabase (server/browser) y el flujo de sesión.
2. Implementar `authz` leyendo el rol del claim.
3. Proteger el layout del panel con el gate de rol.
4. Implementar el refresh de sesión al cambiar rol.

## Acceptance Criteria
1. **Gate de panel**
   - Given un usuario `citizen` autenticado
   - When visita `/panel`
   - Then es redirigido y no accede al panel.

2. **authz autoriza por rol**
   - Given un usuario `staff`
   - When `authz` evalúa el acceso al panel
   - Then concede acceso; para `citizen` lo deniega.

3. **Refresco de rol no usa claim obsoleto**
   - Given un usuario cambiado a `staff`
   - When refresca su sesión
   - Then el claim refleja `staff` y el gate lo deja pasar.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: auth, roles, security, panel
- **Required Skills**: Supabase Auth, Next.js middleware/layouts
- **Related Tasks**: step13 (panel), step14 (mis reportes)
- **Step**: 04 of 15
- **Files to Modify**: `src/lib/supabase/server.ts`, `src/lib/supabase/browser.ts`, `src/lib/services/authz.ts`, `src/app/(panel)/layout.tsx`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
