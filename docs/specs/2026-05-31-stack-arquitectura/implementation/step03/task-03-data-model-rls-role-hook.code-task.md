## Status: PENDING
## Blocked-By: step02/task-02-supabase-postgis-migrations.code-task.md
## Completed:

# Task: Modelo de datos + RLS + hook de rol JWT

## Description
Crear las tablas núcleo del dominio de reportes con sus políticas Row Level
Security por rol, y un custom access token hook que expone `profiles.role` como
claim del JWT para que RLS lo evalúe sin joins costosos.

## Background
RLS es la red de seguridad: aunque la API use service-role, las políticas
protegen ante cualquier fallo o acceso directo. El reporte nace invisible
(`is_visible=false`) y la media nace `pending`; estas defaults son la base del
gate de visibilidad. El rol vive en `profiles.role`.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§4 Modelo de datos, RLS)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 3)
- Skills: `supabase:supabase`, `supabase:supabase-postgres-best-practices`

**Note:** You MUST read the detailed design before implementing.

## Technical Requirements
1. Migración `0002_core_tables.sql`: `profiles`, `categories`, `reports`,
   `report_media`, `report_status_history` con tipos y defaults de la spec
   (`reports.is_visible` default false; `report_media.processing_state` default
   `pending`); índice GIST sobre `reports.location`; índices de `status` y
   `created_at`.
2. Migración `0003_rls_policies.sql`: todas las políticas RLS de la spec §4.
3. Migración `0004_role_jwt_hook.sql`: custom access token hook con el claim de rol.
4. Suite pgTAP en `tests/rls/` que verifica las políticas.

## Dependencies
- **Paso 02 completado**: PostGIS habilitado y migraciones operativas.

## Implementation Approach
1. Definir el schema en la migración de tablas con defaults e índices.
2. Escribir las políticas RLS por rol.
3. Configurar el access token hook para el claim de rol.
4. Escribir los tests pgTAP que cubren toda la lista RLS de §4.

## Acceptance Criteria
1. **E2 — Default no visible**
   - Given un reporte recién creado
   - When un lector anónimo consulta `reports`
   - Then no obtiene el reporte (RLS exige `is_visible = true`).

2. **E3 — Solo staff cambia estado (RLS)**
   - Given un usuario con rol `citizen`
   - When intenta UPDATE de `reports.status`
   - Then la política RLS lo rechaza.

3. **E5 — Ciudadano ve los suyos (RLS)**
   - Given un ciudadano autenticado con un reporte propio no visible
   - When consulta sus reportes
   - Then los ve (`reporter_id = auth.uid()`), aunque no sean públicos.

4. **Cobertura RLS completa de §4**
   - Given la suite pgTAP
   - When se ejecuta
   - Then verifica además que `report_status_history` solo es legible por
     staff/admin y que la lectura de `report_media` está ligada a la visibilidad
     del reporte padre.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: database, schema, rls, security, postgis, foundation
- **Required Skills**: Postgres, RLS, PostGIS, pgTAP
- **Related Tasks**: step04 (auth), step05 (reportService)
- **Step**: 03 of 15
- **Files to Modify**: `supabase/migrations/0002_core_tables.sql`, `supabase/migrations/0003_rls_policies.sql`, `supabase/migrations/0004_role_jwt_hook.sql`, `tests/rls/policies.sql`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
