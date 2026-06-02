# Plan de implementación — evidencialo (stack y arquitectura)

- **Fecha**: 2026-05-31
- **Diseño de referencia**: [`../../2026-05-31-stack-arquitectura-design.md`](../../2026-05-31-stack-arquitectura-design.md)
- **Enfoque**: C — Híbrido (escrituras vía API Next.js, lecturas cacheadas)
- **Orden**: deployment-first — infraestructura y gate CI antes de cualquier feature.

Cada paso es independientemente testeable, deja un incremento demostrable, y
define su escenario antes del código (SDD). Los criterios de aceptación citan los
escenarios observables E1–E11 de la spec.

---

## Chunk 1: Mapa de archivos y plan de pasos

## Mapa de archivos

Responsabilidad única por archivo; los que cambian juntos viven juntos.

```
/
├── vercel.json                      # infra declarativa: build, cron, regiones
├── package.json                     # scripts: dev, build, test, test:e2e, lint
├── next.config.ts
├── tsconfig.json
├── capacitor.config.ts              # config Capacitor (server.url a producción)
├── android/                         # proyecto nativo Android generado por Capacitor
├── .github/workflows/ci.yml         # gate CI: lint + test + typecheck (bloquea deploy)
├── .env.example                     # claves: Supabase, MapTiler, Turnstile, Upstash
│
├── supabase/
│   ├── migrations/                  # SQL versionado (una migración por paso de schema)
│   │   ├── 0001_extensions.sql      # PostGIS
│   │   ├── 0002_core_tables.sql     # profiles, categories, reports, report_media, history
│   │   ├── 0003_rls_policies.sql    # políticas por rol
│   │   ├── 0004_harden_functions.sql # remediación de lints de seguridad (step03)
│   │   ├── 0005_role_jwt_hook.sql   # custom access token hook (claim de rol, step04)
│   │   └── 0006_visibility_trigger.sql # trigger sobre report_media.processing_state
│   ├── functions/sanitize-video/    # Edge Function: saneado de metadatos de video
│   │   └── index.ts
│   └── seed.sql                     # categorías iniciales
│
├── src/
│   ├── app/
│   │   ├── (public)/
│   │   │   ├── page.tsx             # mapa público (RSC, cacheado)
│   │   │   └── reportes/[id]/page.tsx
│   │   ├── (capture)/nuevo/page.tsx # flujo de envío (client)
│   │   ├── (panel)/
│   │   │   ├── layout.tsx           # gate auth + rol
│   │   │   ├── page.tsx             # lista + filtros
│   │   │   └── reportes/[id]/page.tsx
│   │   ├── (account)/mis-reportes/page.tsx
│   │   └── api/
│   │       ├── reports/route.ts            # POST crear, GET por bbox
│   │       ├── reports/[id]/status/route.ts# POST cambio de estado (staff)
│   │       ├── media/route.ts              # POST subida imagen (strip EXIF)
│   │       └── cron/cleanup/route.ts       # GET limpieza de huérfanos (Cron)
│   │
│   ├── lib/
│   │   ├── supabase/server.ts       # cliente RSC/route (sesión)
│   │   ├── supabase/browser.ts      # cliente cliente
│   │   ├── supabase/service.ts      # cliente service-role (solo servidor)
│   │   ├── services/reportService.ts# dominio: crear, listar(bbox), cambiar estado
│   │   ├── services/mediaService.ts # procesado: EXIF, thumbnail, processing_state
│   │   ├── services/authz.ts        # resolución de rol y autorización
│   │   ├── exif.ts                  # strip EXIF de imágenes
│   │   ├── geo.ts                   # helpers PostGIS / bbox
│   │   ├── rateLimit.ts             # Upstash Redis
│   │   ├── captcha.ts               # verificación Turnstile
│   │   └── validation/reportSchema.ts # zod: payload + límites de media
│   │
│   ├── components/
│   │   ├── map/MapView.tsx          # MapLibre GL + tiles MapTiler
│   │   ├── capture/CaptureForm.tsx  # cámara/GPS web + Capacitor
│   │   └── panel/StatusControl.tsx
│   └── types/index.ts
│
└── tests/
    ├── unit/                        # Vitest: services, validación, exif, authz
    ├── rls/                         # pgTAP: políticas por rol
    └── e2e/                         # Playwright: envío, panel, mapa
```

## Pasos

| # | Descripción | Tamaño | Dependencias |
|---|---|---|---|
| 1 | Scaffold Next.js + vercel.json + CI gate + app vacía a prod | M | none |
| 2 | Proyecto Supabase enlazado + PostGIS + tooling de migraciones | S | 1 |
| 3 | Migraciones del modelo de datos + RLS + hook de rol JWT | M | 2 |
| 4 | Auth: ciudadano opcional + roles staff; sesión y gate de panel | M | 3 |
| 5 | `reportService` + `POST /api/reports` (validación, límites, idempotencia) | M | 3 |
| 6 | Rate-limit (Upstash) + captcha Turnstile en envíos anónimos | S | 5 |
| 7 | `POST /api/media`: subida de imagen con strip EXIF + thumbnail | M | 5 |
| 8 | Trigger de visibilidad sobre `report_media.processing_state` | S | 7 |
| 9 | Video: URL firmada + Edge Function de saneado (backoff, failed) | M | 8 |
| 10 | Cron de limpieza de reportes huérfanos | S | 9 |
| 11 | Mapa público: `GET /api/reports` por bbox + MapView (MapLibre) | M | 5 |
| 12 | Página de detalle de reporte (pública) | S | 11 |
| 13 | Panel: lista/filtros + `POST /api/reports/[id]/status` + auditoría | M | 4 |
| 14 | Vista "mis reportes" del ciudadano | S | 4 |
| 15 | Shell Android (Capacitor) con cámara/GPS nativos | M | 7 |

---

## Prerrequisitos

- Cuentas: Vercel, Supabase, MapTiler (free tier), Cloudflare Turnstile, Upstash.
- Node LTS + gestor de paquetes (pnpm recomendado).
- Vercel CLI actualizado (`npm i -g vercel@latest` — la sesión trae 54.1.0, hay 54.6.x).
- Supabase CLI para migraciones y Edge Functions.

---

## Pasos de implementación (detalle)

### Fase 1 — Fundación (deployment-first)

- [ ] **Paso 1 — Scaffold + infra + CI + deploy vacío** · M · dep: none
  Crear app Next.js (App Router, TS), `vercel.json` (build, regiones, sección
  cron), `.github/workflows/ci.yml` con gate (lint + typecheck + test) que bloquea
  deploy si falla, y desplegar la app vacía a producción.
  - Escenario: *Given* el repo recién scaffolded, *when* se hace push a main con un
    test que falla, *then* el pipeline no despliega.
  - Aceptación: app vacía accesible en URL de producción; CI rojo bloquea deploy;
    `vercel.json` es parte del commit inicial de infra.

- [ ] **Paso 2 — Supabase enlazado + PostGIS + migraciones** · S · dep: 1
  Crear proyecto Supabase, enlazar, habilitar PostGIS (`0001`), configurar el flujo
  de migraciones y variables de entorno en Vercel.
  - Escenario: *Given* el proyecto enlazado, *when* se aplica la migración de
    extensiones, *then* `postgis` está disponible (`SELECT postgis_version()`).
  - Aceptación: migraciones corren en CI y en remoto; env vars presentes en Vercel.

- [ ] **Paso 3 — Modelo de datos + RLS + hook de rol** · M · dep: 2
  Migraciones `0002`–`0004`: tablas núcleo (con `reports.is_visible` default false y
  `report_media.processing_state` default `pending`), políticas RLS por rol, y
  custom access token hook que expone `profiles.role` como claim.
  - Escenarios: **E2** (default no visible), **E3** (solo staff cambia estado — a
    nivel RLS), **E5** (ciudadano ve los suyos — a nivel RLS).
  - Aceptación: tests pgTAP (`tests/rls/`) verifican toda la lista RLS de la spec
    §4: anónimo no lee `is_visible=false`; `citizen` lee solo
    `reporter_id = auth.uid()`; rol no-staff no puede UPDATE de `status`;
    `report_status_history` solo legible por staff/admin; lectura de
    `report_media` ligada a la visibilidad del reporte padre.

### Fase 2 — Auth y camino de escritura

- [ ] **Paso 4 — Auth + roles + gate de panel** · M · dep: 3
  Supabase Auth: registro/login opcional para ciudadano; asignación de rol staff;
  `authz` resuelve rol desde el claim; `(panel)/layout.tsx` redirige si no es staff.
  El cambio de rol fuerza refresh de sesión (claim no obsoleto).
  - Escenario: *Given* un usuario `citizen` logueado, *when* visita `/panel`,
    *then* es redirigido (sin acceso).
  - Aceptación: unit test de `authz` (rol → permitido/denegado); e2e del gate;
    test del refresco de rol: tras cambiar un usuario a `staff` y refrescar sesión,
    el claim refleja `staff` y el gate lo deja pasar (no evalúa rol obsoleto).

- [ ] **Paso 5 — reportService + POST /api/reports** · M · dep: 3
  `reportService.create` + Route Handler: validación zod (categoría, coordenadas,
  descripción, **límites de media**), clave de idempotencia, crea `reports`
  (`is_visible=false`) y devuelve URL(s) firmada(s).
  - Escenarios: **E11** (reintento idempotente no duplica); límites de media
    rechazados.
  - Aceptación: unit tests de validación y servicio; reintento con misma clave
    devuelve el mismo reporte; payload fuera de límites → 4xx.

- [ ] **Paso 6 — Rate-limit + captcha anónimo** · S · dep: 5
  `rateLimit` (Upstash) por IP/sesión y verificación Turnstile cuando no hay
  sesión, integrados en `/api/reports`.
  - Escenario: **E6** — *Given* un anónimo que excede la ventana, *when* envía otro,
    *then* 429 y no se crea el reporte.
  - Aceptación: unit/integración del límite (429) y rechazo de captcha inválido (403).

- [ ] **Paso 7 — POST /api/media: imagen sin EXIF** · M · dep: 5
  `mediaService` + Route Handler que recibe la imagen, **elimina EXIF** (`lib/exif`),
  comprime, genera thumbnail, guarda con service-role y marca `processing_state`.
  - Escenario (parcial **E1**): *Given* una imagen con EXIF de GPS, *when* se sube,
    *then* el objeto almacenado no contiene EXIF de localización.
  - Aceptación: unit test de `exif` (entrada con GPS → salida sin GPS); test de
    integración de la subida; **subida idempotente** por `report_id` + índice de
    archivo: reintentar la misma subida no crea media duplicada (spec §6).

- [ ] **Paso 8 — Trigger de visibilidad** · S · dep: 7
  Migración `0006`: trigger sobre `report_media.processing_state` que pone
  `reports.is_visible=true` solo cuando ninguna media del reporte queda en
  `pending` ni `failed`. Único punto de verdad de la visibilidad; testeable de
  forma aislada con pgTAP sin que exista aún la Edge Function de video.
  - Escenarios: **E2** (invisible mientras haya `pending`), parte de **E10**
    (cualquier `failed` mantiene invisible), cierre de **E1** (todo `processed` →
    visible).
  - Aceptación: tests pgTAP del trigger con combinaciones
    pending/processed/failed → flag correcto en cada caso.

- [ ] **Paso 9 — Video saneado (Edge Function)** · M · dep: 8
  Subida de video por URL firmada; Edge Function `sanitize-video` que sanea
  metadatos del contenedor, reintenta con backoff y marca `processed`/`failed`.
  El paso a visible lo decide el trigger del Paso 8.
  - Escenarios: cierre de **E1** (video procesado → reporte visible), **E10**
    (video que agota reintentos queda `failed`, registrado, reporte nunca visible).
  - Aceptación: test de la función (saneado correcto; fallo persistente → `failed`
    + registro); integración: reporte con video `failed` permanece invisible.

- [ ] **Paso 10 — Cron de limpieza de huérfanos** · S · dep: 9
  `GET /api/cron/cleanup` (declarado en `vercel.json`) borra reportes
  `is_visible=false` con media `pending` > 24 h y sus objetos en Storage.
  - Escenario: **E9** — huérfano > 24 h se elimina al correr el job.
  - Aceptación: test con reloj inyectado: reporte de 25 h se borra, el de 1 h no.

### Fase 3 — Camino de lectura y superficies

- [ ] **Paso 11 — Mapa público por bbox** · M · dep: 5
  `GET /api/reports` filtra por bounding box con índice GIST (`lib/geo`); `MapView`
  renderiza con MapLibre + MapTiler; solo `is_visible=true`.
  - Escenarios: **E8** (bbox devuelve solo los de dentro), **E2** (excluye no
    visibles).
  - Aceptación: test de la query por bbox; e2e: el mapa pinta marcadores visibles.

- [ ] **Paso 12 — Detalle de reporte público** · S · dep: 11
  Página `(public)/reportes/[id]` con media procesada, categoría, estado, fecha.
  - Escenario: *Given* un reporte visible, *when* se abre su detalle, *then* muestra
    estado y media saneada; un reporte no visible → 404.
  - Aceptación: e2e de detalle; no visible no es accesible.

- [ ] **Paso 13 — Panel: filtros + cambio de estado + auditoría** · M · dep: 4
  Lista con filtros (estado/categoría); `POST /api/reports/[id]/status` verifica rol,
  actualiza estado, escribe `report_status_history`, fija `resolved_at` al resolver.
  - Escenarios: **E3** (no-staff → 403), **E4** (cambio auditado), **E7** (resuelto
    fija `resolved_at`).
  - Aceptación: unit de `authz` + servicio; integración: cambio crea fila de
    historial; pasar a `resuelto` setea `resolved_at`.

- [ ] **Paso 14 — "Mis reportes" del ciudadano** · S · dep: 4
  Vista `(account)/mis-reportes` que lista los reportes del usuario y su estado,
  incluidos los aún no visibles.
  - Escenario: **E5** — ciudadano ve su reporte no visible y su estado.
  - Aceptación: e2e: usuario ve su reporte `is_visible=false`; no ve los de otros.

### Fase 4 — Android

- [ ] **Paso 15 — Shell Capacitor** · M · dep: 7
  `capacitor.config.ts` con `server.url` a producción; proyecto `android/` generado;
  integrar `@capacitor/camera` y `@capacitor/geolocation` en `CaptureForm` con
  fallback a APIs web.
  - Escenario: *Given* la app Android, *when* el usuario captura una foto y la
    envía, *then* el reporte llega a la misma API y sigue el flujo de E1.
  - Aceptación: build de APK; captura nativa funciona; envío end-to-end verde.

---

## Estrategia de testing

- **Unit (Vitest)**: `lib/services/*`, `validation`, `exif`, `geo`, `authz`,
  `rateLimit`. Cubre dominio y puntos de integración (exigido por las reglas).
- **RLS (pgTAP)**: políticas por rol — E2, E3, E5 y la lista completa de §4.
- **E2E (Playwright / agent-browser + dogfood)**: envío web, panel, mapa, detalle,
  mis-reportes. Cero errores de consola, cero peticiones fallidas.
- TDD: el escenario de cada paso se escribe antes del código.

## Plan de despliegue

- **Deploy continuo** desde main vía Vercel; cada PR genera preview.
- **Gate CI** bloquea producción si fallan lint/typecheck/tests.
- **Migraciones** aplicadas en el pipeline antes del deploy.
- **Monitoreo**: Vercel Observability + logs de Supabase; alertas en errores 5xx.

## Procedimiento de rollback

- Revertir al deployment anterior en Vercel (instant rollback).
- Migraciones: cada migración con su `down`; reversión manual coordinada con el
  rollback de código si el cambio toca schema.

---

## Trazabilidad escenario → paso

| Escenario | Paso(s) |
|---|---|
| E1 (envío anónimo sin EXIF, se publica) | 7, 8, 9 |
| E2 (no visible hasta procesar) | 3, 8, 11 |
| E3 (solo staff cambia estado) | 3, 13 |
| E4 (cambio auditado) | 13 |
| E5 (ciudadano sigue los suyos) | 3, 14 |
| E6 (rate-limit anónimo) | 6 |
| E7 (resolver fija resolved_at) | 13 |
| E8 (consulta por bbox) | 11 |
| E9 (limpieza de huérfanos) | 10 |
| E10 (video failed nunca visible) | 8, 9 |
| E11 (reintento idempotente) | 5 |
