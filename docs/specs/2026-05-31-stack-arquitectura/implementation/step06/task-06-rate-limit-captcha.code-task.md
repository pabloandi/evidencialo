## Status: PENDING
## Blocked-By: step05/task-05-report-service-create-api.code-task.md
## Completed:

# Task: Rate-limit (Upstash) + captcha Turnstile en envíos anónimos

## Description
Proteger el endpoint de creación de reportes contra spam de envíos anónimos:
rate-limit por IP/sesión con Upstash Redis y verificación de captcha (Cloudflare
Turnstile) cuando no hay sesión.

## Background
El envío anónimo abre la puerta a spam; el control debe vivir en el servidor.
Supabase no ofrece rate-limit nativo, de ahí Upstash. El captcha solo se exige a
clientes sin sesión.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§2, §5, §6)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 6)
- Skill: `vercel-plugin:vercel-storage` (Upstash via Marketplace)

**Note:** You MUST read the detailed design before implementing. Verifica la API
de Upstash y Turnstile en docs vigentes.

## Technical Requirements
1. `lib/rateLimit.ts` (Upstash Redis) con ventana y umbral configurables.
2. `lib/captcha.ts` verifica el token Turnstile.
3. Integración en `app/api/reports/route.ts`: rate-limit siempre; captcha solo si
   no hay sesión.

## Dependencies
- **Paso 05 completado**: el endpoint de creación existe.
- **Cuentas Upstash y Turnstile**: claves en env vars.

## Implementation Approach
1. Implementar el cliente de rate-limit con Upstash.
2. Implementar la verificación de Turnstile.
3. Integrar ambos en el handler de creación con el orden correcto.

## Acceptance Criteria
1. **E6 — Rate-limit frena spam anónimo**
   - Given un cliente anónimo que ya envió N reportes en la ventana
   - When intenta enviar uno más
   - Then la API responde 429 y no crea el reporte.

2. **Captcha inválido rechazado**
   - Given un envío anónimo con token Turnstile inválido o ausente
   - When llega a `/api/reports`
   - Then la API responde 403 y no crea el reporte.

3. **Usuario con sesión no requiere captcha**
   - Given un ciudadano autenticado dentro del límite
   - When envía un reporte sin token de captcha
   - Then la API lo acepta (no exige captcha a sesiones).

## Metadata
- **Complexity**: Low
- **Estimated Effort**: S
- **Labels**: security, rate-limit, captcha, write-path, anti-spam
- **Required Skills**: Upstash Redis, Cloudflare Turnstile, Next.js
- **Related Tasks**: step05
- **Step**: 06 of 15
- **Files to Modify**: `src/lib/rateLimit.ts`, `src/lib/captcha.ts`, `src/app/api/reports/route.ts`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: S
- **Scenario-Strategy**: required
