# Planning Summary: evidencialo — stack y arquitectura

**Date**: 2026-05-31
**Goal**: Definir stack y arquitectura, y producir un plan de implementación
deployment-first para una app de reporte ciudadano de problemas de
infraestructura urbana (web + Android), sobre Next.js + Supabase en Vercel.

## Artifacts Created

- `../2026-05-31-stack-arquitectura-design.md` — diseño detallado (spec aprobada;
  sirve de design doc de este plan).
- `design/README.md` — puntero al diseño detallado.
- `implementation/plan.md` — plan de 15 pasos con mapa de archivos, criterios de
  aceptación y trazabilidad a escenarios E1–E11.
- `summary.md` — este resumen.

(Los pasos de clarificación y research de sop-planning se reutilizaron de la fase
de brainstorming, ya consolidados en la spec aprobada — ruta "directo al plan"
elegida por el usuario.)

## Key Decisions

1. **Enfoque híbrido (C)**: escrituras vía API de Next.js (validación,
   rate-limit, captcha, strip EXIF, roles); lecturas del mapa público cacheadas.
   El envío anónimo obliga a control servidor-side; penalizar las lecturas con
   ese servidor sería malgastar cache.
2. **Visibilidad por trigger de BD**: único punto de verdad que cierra el race
   entre el procesado de imagen y el de video; un reporte no se publica hasta que
   toda su media está saneada (sin EXIF) — protege PII de geolocalización.
3. **MapLibre + MapTiler** en vez de Google Maps: evita facturación por carga en
   una vista pública abierta.
4. **Android vía Capacitor** (`server.url` a producción): una sola base web,
   cámara/GPS nativos; descartado Electron (escritorio) y Cordova (mantenimiento).
5. **Deployment-first**: `vercel.json` + Supabase enlazado + gate CI antes de
   cualquier feature; app vacía a producción en las 2 primeras horas.

## Complexity Estimate

- **Overall**: L (15 pasos, 4 fases, 5 servicios externos).
- **Duration**: estimación ~25–35 h de implementación (pasos S/M ≤ 2 h c/u).
- **Risk Level**: Medium — riesgos concentrados en el pipeline de media
  (saneado de EXIF/video, trigger de visibilidad) y en la carga de Capacitor con
  contenido remoto.

## Recommended Next Steps

1. Revisar este plan (gate de usuario).
2. Generar tareas ejecutables con `sop-task-generator`, o ejecutar directamente
   con `sop-code-assist` / `ralph-orchestrator`.
3. Arrancar por el Paso 1 (infra + CI + deploy vacío) — deployment-first.
4. Provisionar cuentas externas (Supabase, MapTiler, Turnstile, Upstash) antes
   del Paso 2/6.

## Open Questions

Heredadas de la spec (no bloquean el plan; confirmables sin invalidar la
arquitectura): proveedor de mapas (MapLibre+MapTiler), modo Capacitor
(`server.url` vs bundle estático), backend de rate-limit (Upstash).
