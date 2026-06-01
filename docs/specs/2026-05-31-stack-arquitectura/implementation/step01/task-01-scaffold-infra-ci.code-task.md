## Status: IN_PROGRESS
## Blocked-By:
## Completed:

<!--
PROGRESO (2026-05-31):
DONE y verificado:
- Scaffold Next.js 16.2.6 (App Router, TS, Tailwind, src/) en la raíz.
- vercel.json versionado (framework nextjs + cron diario reservado).
- CI gate en GitHub Actions: quality (lint/typecheck/test 2/2/build) PASA en
  runner limpio; deploy needs:quality, no-op hasta tener VERCEL_TOKEN. Run verde.
- Repo: github.com/pabloandi/evidencialo (privado), main empujado.
- Deploy PREVIEW en Vercel (scope andresamaw-1043s-projects), readyState READY.
- AC3 (vercel.json primer commit infra): cumplido.
- AC2 (gate bloquea deploy): estructura needs:quality + quality verificado verde.

PENDIENTE (acciones del usuario):
- AC1 (app en URL de PRODUCCIÓN): usuario eligió "preview primero". Promover con
  `vercel deploy --prod --scope andresamaw-1043s-projects` cuando dé el visto bueno.
- Crear VERCEL_TOKEN en el dashboard de Vercel y añadirlo como secret de GitHub
  (gh secret set VERCEL_TOKEN) para activar el auto-deploy de CI.
- Preview tras muro de auth (Vercel Deployment Protection, 401) — ajustar si se
  quiere acceso público / QA de navegador.
- Follow-up menor: acciones de Actions corren en Node 20 (deprecado jun-2026).
-->


# Task: Scaffold Next.js + infraestructura declarativa + gate CI + deploy vacío

## Description
Crear el esqueleto de la aplicación Next.js (App Router, TypeScript) y la
infraestructura declarativa de despliegue antes de cualquier código de feature.
Configurar el gate CI que bloquea el despliegue si fallan lint/typecheck/tests, y
desplegar la app vacía a producción para probar que la infra funciona.

## Background
Regla deployment-first del proyecto: la infraestructura (`vercel.json`) es el
primer commit, y una app vacía debe llegar a producción temprano para validar el
pipeline antes de acumular código. El gate CI es obligatorio y no admite
overrides manuales. Stack: Next.js en Vercel (ver diseño).

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§8 Despliegue)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 1)
- Skill de apoyo: `vercel-plugin:deployments-cicd`, `vercel-plugin:vercel-cli`

**Note:** You MUST read the detailed design before implementing. Verifica la API
de `vercel.json` y los workflows de CI en docs vigentes (no de memoria).

## Technical Requirements
1. App Next.js (App Router, TypeScript) que compila y arranca en local.
2. `vercel.json` versionado: build, regiones, y sección de cron reservada.
3. `.github/workflows/ci.yml` que ejecuta lint + typecheck + tests y bloquea el
   deploy en fallo.
4. `.env.example` con las claves previstas (Supabase, MapTiler, Turnstile, Upstash).
5. App desplegada y accesible en una URL de producción.

## Dependencies
- **Cuenta Vercel**: proyecto enlazado; verificar con un deploy de prueba.
- **Runner de tests configurado** (Vitest) para que el gate tenga algo que correr.

## Implementation Approach
1. Inicializar el proyecto Next.js con TypeScript y App Router.
2. Añadir `vercel.json` como commit de infra.
3. Configurar el workflow de CI con los jobs de calidad como gate.
4. Enlazar el proyecto a Vercel y desplegar la app vacía a producción.
5. Probar el gate con un test que falla a propósito y revertir.

**Note:** Suggested approach; alternativas válidas si cumplen los criterios.

## Acceptance Criteria
1. **App vacía en producción**
   - Given el repo recién scaffolded
   - When se completa el primer despliegue
   - Then la app vacía es accesible en una URL de producción.

2. **El gate CI bloquea el deploy en fallo**
   - Given un push a main con un test que falla
   - When corre el pipeline
   - Then el pipeline queda en rojo y NO despliega a producción.

3. **Infra declarativa versionada**
   - Given el historial de git
   - When se inspecciona el commit de infra
   - Then `vercel.json` está presente y forma parte del repo antes de cualquier
     código de feature.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: infra, deployment, ci, foundation
- **Required Skills**: Next.js, Vercel, GitHub Actions
- **Related Tasks**: step02 (Supabase)
- **Step**: 01 of 15
- **Files to Modify**: `vercel.json`, `.github/workflows/ci.yml`, `package.json`, `next.config.ts`, `.env.example`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: S
- **Scenario-Strategy**: required
