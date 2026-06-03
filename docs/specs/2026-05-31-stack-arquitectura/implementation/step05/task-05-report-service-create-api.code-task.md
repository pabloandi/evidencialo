## Status: DONE
## Blocked-By: step03/task-03-data-model-rls-role-hook.code-task.md
## Completed:

<!--
PROGRESO (2026-06-02):
DONE y verificado (commit f909488):
- Holdout SDD: docs/specs/.../scenarios/report-create.scenarios.md (SCEN-001..009)
  + report-create-hardening.scenarios.md (SCEN-010 key vacía, SCEN-011 numéricos
  malformados, SCEN-012 atomicidad). Comiteados antes de implementar.
- Migración 0006_report_idempotency_and_storage.sql: reports.idempotency_key +
  índice único PARCIAL (where not null → idempotencia race-safe, múltiples NULL
  para anónimos); bucket privado 'report-media'; RPC create_report() SECURITY
  DEFINER (search_path='', execute solo a service_role) que inserta report+media
  en UNA transacción con on conflict do nothing (atomicidad SCEN-012 + replay).
- reportSchema.ts (zod): checks de negocio ordenados con mensajes ES exactos +
  guards numéricos int/positive (rechaza 0/negativo/float → invalid_payload, no 500).
- supabase/admin.ts: cliente service-role (bypass RLS, solo server). Workaround
  NoopWebSocket para Node 20 (createClient construye RealtimeClient eager).
- reportService.ts: resuelve categoría (CategoryInvalid antes de escribir), llama
  la RPC, firma upload URLs en PARALELO (Promise.all) con upsert (retry tras subida
  parcial seguro).
- route.ts: errores 422 estructurados; 201 fresh / 200 replay idempotente;
  Idempotency-Key vacío/whitespace → undefined → NULL (sin colisión cross-request).
- Tests: vitest 38 (schema/service/route, hermético) + integración local (invisible,
  idempotente count=1, rollback atómico). lint/typecheck/build exit 0.
- Quality gate: 4 agentes (code-review, edge-case, performance, security).
  Security LIMPIO. Los hallazgos de correctness (atomicidad, replay race, numéricos,
  key vacía) se corrigieron — ver SCEN-010/011/012.

DESVIACIÓN de diseño (documentada, actualiza §5.3):
- Las imágenes NO suben bytes-a-través-de-/api/media; TODA la media sube por signed
  upload URL directo al bucket privado. El strip de EXIF pasa a procesamiento async
  server-side (step07 leerá el raw → limpia → marca processed). Razón: honra AC3
  uniforme + respeta límites de body de Vercel (imágenes hasta 10MB).
- Numeración migraciones: 0006 = idempotency+storage (step05); el trigger de
  visibilidad (step08) pasó a 0007.

ACEPTACIÓN:
- AC1 (E11 reintento idempotente): SATISFECHO + runtime (replay 200 mismo id,
  count=1) + RPC on-conflict race-safe.
- AC2 (límites de media → 4xx): SATISFECHO + unit + runtime (oversize 422).
- AC3 (nace invisible + URL firmada): SATISFECHO + integración (is_visible=false,
  pending) + runtime (201 con signedUrl).

ACCIÓN PENDIENTE DEL USUARIO:
- Añadir SUPABASE_SERVICE_ROLE_KEY a .env.local (local, valor de `supabase status`)
  y a Vercel env (prod, server-side, NO NEXT_PUBLIC_). Sin ella createAdminSupabase()
  lanza. (No puedo escribir archivos .env — están en deny-list.)
- Migración 0006 aplicada al remoto (ver abajo); confirmar bucket+RPC en dashboard.
-->

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
