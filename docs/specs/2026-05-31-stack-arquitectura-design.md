# Diseño: stack y arquitectura — evidencialo

- **Fecha**: 2026-05-31
- **Estado**: Aprobado (diseño) — pendiente de revisión de spec
- **Autor**: brainstorming (Claude Code) + Pablo Andi
- **Enfoque elegido**: C — Híbrido (escrituras vía API, lecturas cacheadas)

---

## 1. Contexto y propósito

evidencialo es una aplicación de reporte ciudadano de problemas de
infraestructura urbana: baches, basuras no recogidas, alumbrado roto y
similares. Un reporte es **media geolocalizada** (foto o video) + categoría +
descripción. El activo central es la media atada a una ubicación, no el texto.

El MVP cubre tres superficies sobre un mismo modelo de reportes:

1. **Captura ciudadana** — web (navegador) y Android (app), con cuenta opcional.
2. **Panel de gestión** — personal municipal autenticado, con roles, que filtra
   reportes y cambia su estado.
3. **Mapa público** — cualquiera ve los reportes visibles y su estado.

### Restricciones acordadas

- Stack base: **Vercel + Supabase** (decidido).
- Identidad ciudadana: **cuenta opcional** — el envío anónimo está permitido; la
  cuenta habilita seguimiento de reportes propios y avisos de cambio de estado.
- **Sin modo offline en el MVP** — la captura requiere conexión.
- Android empaquetado con **Capacitor** (no Electron, que es de escritorio; no
  Cordova, en mantenimiento).
- Idioma de usuario final: español. Código, commits y archivos de contexto en
  inglés.

### Fuera de alcance (MVP)

- Cola offline / sincronización en campo.
- Confirmación cruzada de reportes por otros ciudadanos (votos / "yo también").
- Notificaciones push nativas (se contempla como evolución, no MVP).
- Integraciones con sistemas municipales externos.

---

## 2. Arquitectura de alto nivel

```
┌─────────────────────┐     ┌─────────────────────┐
│  Web (navegador)    │     │  Android (Capacitor)│
│  - captura          │     │  - captura nativa   │
│  - mapa público     │     │    cámara + GPS     │
│  - panel gestión    │     │  (carga la web app) │
└──────────┬──────────┘     └──────────┬──────────┘
           │  HTTPS                     │
           ▼                            ▼
   ┌───────────────────────────────────────────┐
   │   Next.js (App Router) en Vercel          │
   │  ── Lecturas: RSC + cache (mapa, detalle) │
   │  ── Escrituras: Route Handlers (/api/*)   │
   │     validan · rate-limit · captcha ·      │
   │     strip EXIF · URLs firmadas · roles    │
   └───────┬──────────────────────┬────────────┘
           │ service-role         │ signed URL
           ▼                      ▼
   ┌──────────────┐      ┌──────────────────┐
   │ Supabase     │      │ Supabase Storage │
   │ Postgres +   │      │ fotos / video    │
   │ PostGIS+Auth │      │ (procesada)      │
   │ (RLS backstop)│     └──────────────────┘
   └──────────────┘
```

Una sola aplicación **Next.js (App Router, TypeScript)** sirve las tres
superficies mediante grupos de rutas. **Supabase** aporta datos (Postgres +
PostGIS), autenticación y almacenamiento de media. La API de Next.js es la
**frontera de escritura**; las lecturas públicas se sirven con render de
servidor cacheado.

**Principio del enfoque híbrido (C):** las escrituras (enviar reporte, cambiar
estado, subir media) pasan por la API de Next.js, donde se concentran
validación, rate-limit, captcha para anónimos, eliminación de EXIF y control de
rol. Las lecturas del mapa público se cachean y no pagan el coste del servidor
en el camino caliente. Cada cosa donde rinde: seguridad en escritura, cache en
lectura.

### Decisiones de stack confirmadas

- **Mapa**: MapLibre GL JS + tiles de MapTiler (free tier). Evita la facturación
  por carga de Google Maps, crítico en una vista pública abierta.
- **Android**: Capacitor con `server.url` apuntando a la URL de producción. La
  app muestra la web en vivo y usa cámara/GPS nativos vía el puente de
  Capacitor. Ventaja: el contenido se actualiza sin release en la store.
  Desventaja: requiere red siempre (aceptable, sin offline) y la store puede
  escrutar contenido remoto. Fallback documentado: empaquetar el flujo de
  captura como bundle estático.
- **Rate-limit**: Upstash Redis (vía Vercel Marketplace) para limitar envíos
  anónimos. Supabase no ofrece rate-limit nativo.
- **Captcha**: Cloudflare Turnstile en envíos anónimos.

---

## 3. Componentes y límites de responsabilidad

| Unidad | Propósito | Depende de |
|---|---|---|
| `app/(capture)` | Flujo ciudadano de envío (client component) | API `/api/reports`, `/api/media` |
| `app/(public)` | Mapa + detalle de reporte (RSC, cacheado) | `reportService` (lectura) |
| `app/(panel)` | Dashboard staff: filtrar, cambiar estado (auth + rol) | `reportService`, `authz` |
| `app/api/reports` | Crear reporte, emitir URLs firmadas de subida | `reportService`, `rateLimit`, captcha |
| `app/api/reports/[id]/status` | Cambiar estado (solo staff/admin) | `authz`, `reportService` |
| `app/api/media` | Subida de imagen a través del servidor (strip EXIF) | `mediaService`, `lib/exif` |
| `lib/services/reportService` | Lógica de dominio de reportes (crear, listar, cambiar estado) | supabase server client |
| `lib/services/mediaService` | Procesado de media (EXIF, thumbnails, marca processed) | `lib/exif`, Storage |
| `lib/services/authz` | Resolución de rol y autorización | supabase server client |
| `lib/exif`, `lib/geo` | Strip de EXIF; helpers PostGIS | — |
| `lib/supabase/{server,browser}` | Clientes Supabase (service-role vs anon) | — |
| `capacitor/` | Shell Android + plugins cámara/GPS | la web app desplegada |

Cada unidad tiene un propósito único y se comunica por interfaces explícitas.
`lib/services/*` es lógica pura testeable sin depender del runtime HTTP: los
Route Handlers son adaptadores delgados sobre los servicios.

---

## 4. Modelo de datos

### Tablas núcleo

- **`profiles`** — `id` (→ `auth.users`), `role` (`citizen` | `staff` |
  `admin`), `display_name`, `created_at`.
- **`categories`** — `id`, `slug`, `name`, `icon`. Semilla inicial: bache,
  basura, alumbrado, señalización, otros.
- **`reports`** — `id`, `reporter_id` (nullable → anónimo), `category_id`,
  `status` (`nuevo` | `en_proceso` | `resuelto` | `descartado`), `description`,
  `location geography(Point, 4326)`, `address` (nullable), `is_visible` (bool,
  default false), `created_at`, `updated_at`, `resolved_at` (nullable).
- **`report_media`** — `id`, `report_id`, `storage_path`, `type` (`image` |
  `video`), `width`, `height`, `duration_s` (nullable), `processing_state`
  (`pending` | `processed` | `failed`, default `pending`), `created_at`. El gate
  de visibilidad trata `processed` como condición de publicación y `failed` como
  bloqueo permanente.
- **`report_status_history`** — `id`, `report_id`, `from_status`, `to_status`,
  `changed_by` (→ profiles), `note` (nullable), `created_at`. Auditoría para el
  panel.

### Índices y extensiones

- Extensión **PostGIS** habilitada.
- Índice GIST sobre `reports.location` para consultas del mapa por bounding box.
- Índice sobre `reports.status` y `reports.created_at` para el panel.

### Row Level Security (RLS)

RLS activo en todas las tablas como defensa en profundidad (la API usa
service-role, pero RLS protege ante cualquier fallo o acceso directo):

- **`reports` lectura pública**: solo filas con `is_visible = true`.
- **`reports` lectura propia**: un ciudadano autenticado ve sus propios reportes
  (`reporter_id = auth.uid()`) aunque no sean visibles aún.
- **`reports` cambio de estado**: solo rol `staff` o `admin`.
- **`report_media` lectura**: ligada a la visibilidad del reporte padre.
- **`report_status_history`**: lectura solo staff/admin; escritura por la API.

El rol se modela en `profiles.role` y se expone como claim del JWT de Supabase
(custom access token hook) para que RLS lo evalúe sin un join costoso. Cuando un
admin cambia el rol de un usuario, el claim queda obsoleto hasta el siguiente
refresco de token; el cambio de rol fuerza un refresh de sesión para que RLS no
evalúe un rol caducado.

---

## 5. Flujo de datos — envío de reporte

1. El cliente captura foto/video + GPS + categoría + descripción.
2. `POST /api/reports` (con token Turnstile si es anónimo). La API:
   - valida payload (categoría válida, coordenadas en rango, longitud de
     descripción);
   - aplica **rate-limit** (Upstash) por IP/sesión;
   - verifica captcha si es anónimo;
   - crea la fila `reports` con `is_visible = false`;
   - devuelve URL(s) firmada(s) de subida y el `report_id`.
3. **Imágenes**: se suben **a través de `/api/media`**. El servidor elimina EXIF
   (la geolocalización incrustada es PII y no debe filtrarse al hacerse
   público), comprime, genera thumbnail y guarda en Storage con service-role.
4. **Video**: se sube vía URL firmada directa a Storage; una Supabase Edge
   Function sanea metadatos del contenedor y marca `processed = true`.
5. Cuando **toda** la media del reporte tiene `processed = true`, el reporte pasa
   a `is_visible = true`. El flip lo realiza un **trigger de base de datos** sobre
   `report_media.processed`: tras cada actualización, comprueba si quedan filas
   sin procesar para ese `report_id` y, si no quedan, marca el reporte visible.
   Esto cierra la condición de carrera entre la ruta de imagen (`/api/media`) y la
   de video (Edge Function), que procesan en paralelo: ninguna de las dos decide
   la visibilidad, lo hace el trigger como único punto de verdad.

**Justificación del gate de visibilidad:** un reporte no se publica hasta que su
media está procesada y libre de EXIF. Evita exponer PII de localización y media
sin sanear durante la ventana de subida.

### Límites de media (MVP)

- **Imagen**: formatos `jpeg`/`png`/`webp`; tamaño máximo 10 MB por archivo;
  máximo 3 imágenes por reporte.
- **Video**: formato `mp4`; duración máxima 60 s; tamaño máximo 50 MB; 1 video
  por reporte. Estos topes acotan el coste de Storage y la superficie de abuso en
  envíos anónimos. Se validan en `/api/reports` antes de emitir la URL firmada.

### Caminos de fallo del procesado

- **Imagen** (`/api/media`): si el strip de EXIF o la subida falla, la respuesta
  es 5xx, la media no queda `processed` y el cliente reintenta (idempotente por
  `report_id` + índice de archivo). El reporte permanece invisible.
- **Video** (Edge Function): si el saneado de metadatos falla, la media no queda
  `processed` y el reporte permanece invisible. La función reintenta con backoff;
  tras N intentos, marca la media como `failed` y registra el error para revisión
  en el panel. Un reporte con media `failed` nunca se publica.
- **Reportes huérfanos**: un job programado (Vercel Cron) elimina reportes con
  `is_visible = false` cuya media sigue sin procesar tras 24 h, junto con sus
  objetos parciales en Storage. Evita acumulación de envíos abandonados.

### Flujo — cambio de estado (panel)

1. Staff autenticado abre el panel (`app/(panel)`), filtra por estado/categoría.
2. `POST /api/reports/[id]/status` con nuevo estado y nota opcional.
3. La API verifica rol (`authz`), actualiza `reports.status`, escribe en
   `report_status_history`, y si pasa a `resuelto` fija `resolved_at`.
4. Si el reporte tiene `reporter_id`, se encola un aviso al ciudadano (evolución;
   en MVP basta con que el ciudadano vea el cambio al consultar sus reportes).

---

## 6. Manejo de errores

- **Validación** → respuesta 4xx con cuerpo estructurado y mensajes en español
  para la UI.
- **Fallo de subida de media** → el reporte queda con `is_visible = false` y
  media sin `processed`; el cliente reintenta la subida. No quedan reportes
  visibles a medias.
- **Captcha / rate-limit** → 403 / 429 con mensaje claro.
- **RLS como red de seguridad** ante cualquier fallo de la capa API.
- **Idempotencia**: `POST /api/reports` y las subidas a `/api/media` aceptan una
  clave de idempotencia (cliente) para que los reintentos por red no creen
  reportes ni media duplicados.
- **Observabilidad**: Vercel Observability (logs, trazas) + logs de Supabase.
  Errores de servidor se registran con contexto del `report_id`.

---

## 7. Estrategia de testing

Conforme a las reglas del proyecto (TDD para features nuevas; gate CI
obligatorio; cobertura en servicios de negocio y puntos de integración):

- **Vitest** — `lib/services/*` y Route Handlers: validación, rate-limit, strip
  EXIF, checks de rol, gate de visibilidad. Son la lógica de dominio y los
  puntos de integración que las reglas exigen cubrir.
- **Tests de RLS** (pgTAP o helpers de Supabase) — políticas de lectura/escritura
  por rol: anónimo no ve `is_visible=false`, ciudadano ve los suyos, solo staff
  cambia estado.
- **Playwright / agent-browser + dogfood** — flujos E2E: envío web, cambio de
  estado en panel, render del mapa público. Cero errores de consola, cero
  peticiones fallidas.
- **Sin flujos de pago** en el MVP (N/A).

---

## 8. Despliegue (deployment-first)

- **`vercel.json` como primer commit** — la infraestructura declarativa precede
  al código.
- Proyecto **Supabase** enlazado; variables de entorno gestionadas en Vercel
  (incluyendo claves de Supabase, MapTiler, Turnstile, Upstash).
- **Gate CI obligatorio**: el pipeline no despliega si los tests fallan. Sin
  excepciones ni overrides manuales.
- **App vacía a producción dentro de las 2 primeras horas** para probar que la
  infra funciona antes de acumular código.

---

## 9. Escenarios observables (Given/When/Then)

Puente hacia scenario-driven-development. Cada decisión de diseño tiene al menos
un escenario observable que define "hecho".

**E1 — Envío anónimo válido se publica sin EXIF**
Given un visitante anónimo con captcha resuelto y una foto con EXIF de
geolocalización,
When envía un reporte con categoría "bache", descripción y ubicación,
Then el reporte se crea, la imagen almacenada no contiene EXIF de localización,
y tras procesarse la media el reporte pasa a `is_visible = true` y aparece en el
mapa público.

**E2 — Reporte no visible hasta procesar media**
Given un reporte recién creado con media aún sin procesar,
When un visitante consulta el mapa público,
Then ese reporte no aparece (`is_visible = false`).

**E3 — Solo staff cambia el estado**
Given un usuario con rol `citizen` autenticado,
When intenta `POST /api/reports/[id]/status`,
Then la API responde 403 y el estado del reporte no cambia.

**E4 — Cambio de estado queda auditado**
Given un usuario `staff`,
When cambia un reporte de `nuevo` a `en_proceso` con una nota,
Then `reports.status` se actualiza y se inserta una fila en
`report_status_history` con `from_status`, `to_status`, `changed_by` y la nota.

**E5 — Ciudadano sigue sus propios reportes**
Given un ciudadano autenticado con un reporte propio aún no visible,
When consulta sus reportes,
Then ve el reporte y su estado actual, aunque no sea público.

**E6 — Rate-limit frena spam anónimo**
Given un cliente anónimo que ya envió N reportes en la ventana,
When intenta enviar uno más,
Then la API responde 429 y no se crea el reporte.

**E7 — Resolver fija la fecha de resolución**
Given un reporte en `en_proceso`,
When un staff lo pasa a `resuelto`,
Then `resolved_at` queda con la marca temporal del cambio.

**E8 — Mapa consulta por bounding box**
Given reportes visibles en distintas coordenadas,
When el mapa público pide reportes para un bounding box,
Then solo devuelve los reportes visibles dentro de ese recuadro (usando el
índice GIST de PostGIS).

**E9 — Reporte huérfano se limpia tras 24 h**
Given un reporte con `is_visible = false` cuya media sigue en `pending` desde
hace más de 24 h,
When corre el job programado de limpieza,
Then el reporte y sus objetos parciales en Storage se eliminan.

**E10 — Video que falla el saneado nunca se publica**
Given un reporte cuyo único video agota los reintentos de saneado y queda en
`processing_state = failed`,
When el trigger de visibilidad evalúa el reporte,
Then el reporte permanece `is_visible = false` y el fallo queda registrado para
revisión en el panel.

**E11 — Reintento idempotente no duplica**
Given un cliente que reintenta `POST /api/reports` con la misma clave de
idempotencia tras un fallo de red,
When la API recibe el segundo intento,
Then no se crea un reporte duplicado y se devuelve el reporte ya creado.

---

## 10. Decisiones abiertas (a confirmar en planning si cambian)

Estas quedaron como recomendación en el diseño y se asumen para la spec; pueden
revisarse en sop-planning sin invalidar la arquitectura:

1. MapLibre + MapTiler como motor/proveedor de mapas.
2. Capacitor `server.url` vs bundle estático para Android.
3. Upstash Redis como backend de rate-limit.
