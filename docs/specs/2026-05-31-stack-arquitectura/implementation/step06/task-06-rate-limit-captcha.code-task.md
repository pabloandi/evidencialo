## Status: DONE
## Blocked-By: step05/task-05-report-service-create-api.code-task.md
## Completed:

<!--
PROGRESO (2026-06-02):
DONE y verificado:
- Holdout SDD: docs/specs/.../scenarios/report-antispam.scenarios.md (SCEN-001..008).
- src/lib/rateLimit.ts: checkRateLimit(identifier, limiter?) con Upstash
  slidingWindow (Redis.fromEnv). max/window configurables (RATE_LIMIT_MAX=5,
  RATE_LIMIT_WINDOW="10 m") con VALIDACIÓN de window (regex) → un typo cae a
  default en vez de romper el limiter para siempre. FALLA ABIERTO ante error de
  .limit() (Redis caído no tumba el endpoint; el captcha sigue amurallando).
- src/lib/captcha.ts: verifyCaptcha(token, remoteip?) → Cloudflare siteverify.
  Token trim+cap(2048). FALLA CERRADO (error de red → 403). Sin token → missing
  sin llamar a siteverify.
- route.ts: gates en orden rate-limit → captcha (solo anónimos; sesión exenta).
  clientIp usa el hop de PLATAFORMA (x-vercel-forwarded-for/x-real-ip/trailing
  XFF) — el primer hop de XFF es falsificable. getSessionRole envuelto en
  try/catch → degrada a anónimo (muro captcha) si lanza, nunca 500.
- Tests: vitest 71 (rateLimit + captcha + route). lint/typecheck/build exit 0.
- Quality gate: 3 agentes (security, edge-case, code-review). code-review APROBÓ.
  Fixes aplicados: (1) CRÍTICO fail-open permanente por window malformado;
  (2) IP spoofing por primer hop XFF; (3) getSessionRole sin guard → 500;
  (4) token captcha sin trim/cap. Todos con tests red-green.
- Runtime (puerto limpio): anónimo sin header → 403 captcha_required; secreto
  always-fail → 403 captcha_invalid; XFF multi-hop spoofeado → 403 (IP del
  trailing hop). El path 429 se prueba por unit (no hay Upstash local).

ACEPTACIÓN:
- AC1 (E6 rate-limit 429): SATISFECHO (unit con limiter mockeado, árbitro).
- AC2 (captcha inválido/ausente 403): SATISFECHO + runtime.
- AC3 (sesión no requiere captcha): SATISFECHO (unit: siteverify NO llamado).

ACCIÓN PENDIENTE DEL USUARIO:
- Provisionar Upstash Redis (Vercel Marketplace) → UPSTASH_REDIS_REST_URL +
  UPSTASH_REDIS_REST_TOKEN. Sin ellas el rate-limit FALLA ABIERTO (captcha
  sigue gateando anónimos).
- Provisionar Cloudflare Turnstile → TURNSTILE_SECRET_KEY (server) +
  NEXT_PUBLIC_TURNSTILE_SITE_KEY (widget, paso de UI). Sin TURNSTILE_SECRET_KEY,
  los envíos anónimos dan 500 (config faltante). Añadirlas a .env.local y Vercel.
- (Opcional) RATE_LIMIT_MAX / RATE_LIMIT_WINDOW para tunear (default 5 / "10 m").
-->

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
