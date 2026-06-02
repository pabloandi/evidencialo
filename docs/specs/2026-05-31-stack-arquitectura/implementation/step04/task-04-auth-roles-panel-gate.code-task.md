## Status: DONE
## Blocked-By: step03/task-03-data-model-rls-role-hook.code-task.md
## Completed:

<!--
PROGRESO (2026-06-01):
DONE y verificado:
- Clientes Supabase @supabase/ssr: src/lib/supabase/server.ts (getAll/setAll,
  await cookies() de Next 16) + browser.ts. Key: NEXT_PUBLIC_SUPABASE_ANON_KEY.
- Sesión: src/proxy.ts (Next 16 renombró middleware→proxy; runtime Node por
  defecto) + src/lib/supabase/proxy.ts (updateSession refresca la sesión; NO
  fuerza login global — la app permite anónimos). getClaims() envuelto en
  try/catch (un blip de JWKS no tira páginas anónimas).
- authz: src/lib/services/authz.ts — roleFromClaims/normalizeRole/isStaff/
  canAccessPanel (puros, unit-tested) + getSessionRole (lee claim user_role; si
  el claim no existe cae a profiles). Falla CERRADO en toda incertidumbre.
- Gate: src/app/(panel)/layout.tsx redirige a / si !staff. /panel routable vía
  (panel)/panel/page.tsx (stub para step13; los route groups no añaden segmento).
- Migración 0005_role_jwt_hook.sql: custom_access_token_hook inyecta
  profiles.role como claim user_role. Endurecida: cast UUID y claims con guard
  (un evento malformado NUNCA aborta la emisión de token). Grant execute solo a
  supabase_auth_admin; revocado de anon/authenticated/public. Política
  profiles_select_auth_admin. config.toml habilita el hook en local.
- Tests: vitest 9/9 (authz) + pgTAP 7/7 (role_hook: lógica + privilegios +
  off-nominal) + 9/9 RLS = 16 pgTAP. lint/typecheck/build verdes.
- Aplicado al remoto (0005 + función endurecida vía execute_sql). Security
  advisor: 0 lints.
- Verificado en runtime: /panel anónimo → 307 → / (curl + agent-browser, cero
  errores de consola). E2E del hook: signup local → el JWT emitido contiene
  user_role=citizen (valida el wiring config→GoTrue→hook→claim).

ACEPTACIÓN:
- AC1 (gate): SATISFECHO + verificado en navegador real (redirección 307).
- AC2 (authz por rol): SATISFECHO + unit-tested (staff/admin allow, citizen deny).
- AC3 (claim fresco): mecanismo SATISFECHO + verificado (el hook refleja el rol
  actual en cada emisión de token; pgTAP + e2e). El *trigger* de force-refresh
  ante cambio de rol fuera de banda se cablea cuando exista la acción admin
  (ver DEFERIDO).

DEFERIDO (a su paso natural, documentado — no silenciado):
- UI de login/signup ciudadana → va con el flujo de captura (no en este paso).
- UI/acción admin para asignar rol staff → por ahora manual (SQL/dashboard);
  la asignación de rol staff a un usuario se hace con
  `update public.profiles set role='staff' where id=...`.
- Force-refresh de sesión al cambiar rol → se invoca supabase.auth.refreshSession
  (o re-login) desde la acción admin cuando se construya (step13). Hasta
  entonces, un cambio de rol surte efecto al expirar el token (jwt_expiry 1h) o
  al re-loguear.

ACCIÓN PENDIENTE DEL USUARIO:
- Habilitar el hook en el remoto: Dashboard > Authentication > Hooks >
  Custom Access Token → seleccionar public.custom_access_token_hook. Mientras
  no se active, authz funciona igual (fallback a profiles). Es pura optimización.
- Verificar firma JWT asimétrica (ES256) en el proyecto remoto (Settings > JWT
  Keys). Los proyectos nuevos la traen por defecto; con ella getClaims() valida
  localmente (sin RTT al Auth server en el proxy). Si fuese HS256 (legacy),
  migrar antes de carga.
-->

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
