## Status: PENDING
## Blocked-By: step01/task-01-scaffold-infra-ci.code-task.md
## Completed:

# Task: Proyecto Supabase enlazado + PostGIS + tooling de migraciones

## Description
Crear y enlazar el proyecto Supabase, habilitar la extensión PostGIS mediante una
migración versionada, y dejar el flujo de migraciones operativo en CI y en remoto.
Esto sienta la base de datos sobre la que se construirá el modelo de reportes.

## Background
El activo central de la app es media geolocalizada; PostGIS es necesario para las
consultas por bounding box del mapa. Las migraciones se versionan (una por cambio
de schema) y se aplican en el pipeline antes del deploy.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§4 Modelo de datos)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 2)
- Skill de apoyo: `supabase:supabase`

**Note:** You MUST read the detailed design before implementing. Verifica el flujo
de migraciones y habilitación de extensiones de Supabase en docs vigentes.

## Technical Requirements
1. Proyecto Supabase creado y enlazado al repo (Supabase CLI).
2. Migración `0001_extensions.sql` que habilita PostGIS.
3. Las migraciones se aplican automáticamente en CI y contra el proyecto remoto.
4. Variables de entorno de Supabase presentes en Vercel.

## Dependencies
- **Paso 01 completado**: el repo y el pipeline existen.
- **Cuenta Supabase**: proyecto creado; verificar conexión con la CLI.

## Implementation Approach
1. Crear el proyecto Supabase y enlazarlo con la CLI.
2. Escribir la migración de extensiones (PostGIS).
3. Integrar el comando de migración en el pipeline CI.
4. Cargar las claves de Supabase como env vars en Vercel.

## Acceptance Criteria
1. **PostGIS disponible**
   - Given el proyecto Supabase enlazado
   - When se aplica la migración de extensiones
   - Then `SELECT postgis_version()` devuelve una versión (extensión activa).

2. **Migraciones en el pipeline**
   - Given una migración nueva en el repo
   - When corre el pipeline
   - Then las migraciones se aplican antes del deploy y el job pasa.

3. **Env vars presentes**
   - Given el proyecto en Vercel
   - When se inspeccionan las variables de entorno
   - Then las claves de Supabase necesarias están configuradas.

## Metadata
- **Complexity**: Low
- **Estimated Effort**: S
- **Labels**: supabase, database, postgis, migrations, foundation
- **Required Skills**: Supabase, SQL, PostGIS
- **Related Tasks**: step03 (modelo de datos)
- **Step**: 02 of 15
- **Files to Modify**: `supabase/migrations/0001_extensions.sql`, `.github/workflows/ci.yml`, `.env.example`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: S
- **Scenario-Strategy**: required
