# Guardrails — lecciones de implementación

Léelas antes de ejecutar cualquier `.code-task.md`. Append-only.

### fix-20260531-nextjs16
> El proyecto usa **Next.js 16.2.6 + React 19.2.4**, NO Next 13/14. Hay breaking
> changes vs training. ANTES de escribir Route Handlers, RSC, caché o middleware
> (pasos 5, 7, 8, 11, 12, 13): leer `node_modules/next/dist/docs/` y/o la skill
> `nextjs`. No asumir APIs de memoria.
<!-- tags: nextjs, build | created: 2026-05-31 -->

### fix-20260531-pnpm-workspace
> `create-next-app` genera `pnpm-workspace.yaml` solo con `ignoredBuiltDependencies`
> sin `packages`, y pnpm 10 lo trata como workspace inválido (`packages field
> missing`). Solución aplicada: borrar el archivo y mover `ignoredBuiltDependencies`
> a `package.json` bajo la clave `pnpm`. No es un monorepo.
<!-- tags: build, pnpm | created: 2026-05-31 -->

### fix-20260531-git-identity
> Identidades cruzadas: la clave SSH se autentica como GitHub `amaw-dev`, pero el
> token de `gh` es de `pabloandi`. Push por SSH a un repo de `pabloandi` puede
> fallar por identidad. Solución: `gh auth setup-git` + remote HTTPS para empujar
> con el token de gh (identidad consistente con el dueño del repo).
<!-- tags: git, github | created: 2026-05-31 -->

### fix-20260531-vercel-scope
> Hay dos scopes de Vercel: `andresamaw-1043s-projects` (elegido, personal) e
> `info-42181061s-projects`. El proyecto vive en **andresamaw-1043s-projects**
> (orgId team_0gDIrEJ82nRS9B7qGAn9sDnG, projectId prj_MYSlLDwbKKPcGh6ScmQDNlzfAszP).
> Comandos vercel requieren `--scope andresamaw-1043s-projects`.
<!-- tags: vercel, deploy | created: 2026-05-31 -->

### fix-20260531-vercel-protection
> Los preview deployments están tras **Vercel Deployment Protection** (devuelven
> 401 "Vercel Authentication" a curl anónimo). No es un fallo del app. Para QA de
> navegador anónima o acceso público, ajustar la protección en el dashboard o usar
> un protection-bypass token.
<!-- tags: vercel, verification | created: 2026-05-31 -->

### fix-20260531-vercel-git-connect
> `vercel link` no pudo conectar la integración Git nativa al repo privado de
> `pabloandi` (la cuenta Vercel no tiene acceso). NO dependemos de ello: el deploy
> va por GitHub Actions con `VERCEL_TOKEN`, no por la integración Git de Vercel.
<!-- tags: vercel, ci | created: 2026-05-31 -->

### fix-20260531-actions-node20
> GitHub Actions avisa que las acciones (checkout@v4, setup-node@v4,
> pnpm/action-setup@v4) corren en Node 20, deprecado desde jun-2026. Follow-up:
> subir versiones de acciones o forzar Node 24 cuando toque.
<!-- tags: ci, maintenance | created: 2026-05-31 -->

### fix-20260531-supabase-cloud
> Proyecto Supabase cloud creado vía MCP: org `amaw`
> (msjbvfpopxmhpwpujpbf), project ref **zxhwekkbcjfpwbimtcnn**, región
> **us-east-1** (la más cercana a Colombia — los usuarios son de una ciudad
> colombiana, NO España). URL https://zxhwekkbcjfpwbimtcnn.supabase.co. Las
> migraciones al remoto se aplican con `apply_migration` del MCP (no hay
> `supabase login` CLI; mantener el SQL idéntico a los archivos versionados
> locales). PostGIS 3.3.7 verificado en remoto.
<!-- tags: supabase, cloud, region | created: 2026-05-31 -->

### fix-20260531-vercel-env-preview
> `vercel env add NAME preview` en modo agente (non-interactive por defecto en
> 54.6.x) entra en bucle `git_branch_required` aunque pases `--value ... --yes`.
> Production funciona (sin dimensión de rama). Workaround: añadir las env de
> Preview desde el dashboard, o pasar una rama git concreta como 3er argumento.
> La clave secret/service-role NO la expone el MCP de Supabase (seguridad):
> copiarla del dashboard cuando step05 la necesite.
<!-- tags: vercel, env, supabase | created: 2026-05-31 -->

### fix-20260531-rls-is-staff-private
> is_staff() para RLS DEBE ser SECURITY DEFINER (si no, recursión vía la
> política profiles_select_staff que la llama). Pero en `public` la expone el
> RPC de PostgREST (lint de seguridad). Solución: schema `private` (no expuesto)
> + execute solo a anon/authenticated. Las políticas referencian
> private.is_staff(). Funciones de trigger (set_updated_at, handle_new_user):
> fijar search_path y revocar execute — los triggers disparan sin requerir
> EXECUTE del invocador (verificado: pgTAP staff-update sigue verde).
<!-- tags: supabase, rls, security | created: 2026-05-31 -->

### fix-20260531-pgtap-roles
> Tests RLS pgTAP: las aserciones (is/plan/finish) corren bajo anon/authenticated
> al cambiar de rol, así que `grant execute on all functions in schema
> extensions to anon, authenticated` al inicio del test (DB efímera, rollback).
> Cambiar contexto con `set local role` + `set_config('request.jwt.claims', ...)`;
> `reset role` para leer como postgres (bypass RLS) entre aserciones.
<!-- tags: testing, pgtap, rls | created: 2026-05-31 -->

### fix-20260601-nextjs16-proxy
> Next 16 (v16.0.0) DEPRECÓ `middleware` y lo renombró a **`proxy`**: archivo de
> convención `src/proxy.ts` que exporta `proxy(request)` (+ `config.matcher`).
> Runtime Node.js por defecto (declarar `runtime` en proxy LANZA error). El doc
> oficial advierte: autorizar dentro del Server Component, no confiar solo en el
> proxy. Confirmado en `node_modules/next/dist/docs/.../proxy.md`. El hook
> validador del plugin marca cualquier `*/proxy.ts` con import de `next/server`
> como "renómbralo" — falso positivo para el helper `lib/supabase/proxy.ts`.
<!-- tags: nextjs, proxy, build | created: 2026-06-01 -->

### fix-20260601-supabase-ssr-getclaims
> @supabase/ssr 0.10.x en Next 16: clientes con `getAll/setAll` + `await
> cookies()` (cookies() es async). Server-side usar **`getClaims()`** (NO
> `getSession()`, no confiable en servidor); claims en `data.claims`, custom
> claim en `data.claims.user_role`. getClaims valida la firma del JWT —
> localmente si el proyecto firma con **claves asimétricas (ES256)**, pero
> delega a `getUser()` (RTT al Auth server) si es HS256 legacy. getClaims puede
> THROW (no solo devolver error) en fallo de red al traer JWKS → envolver en
> try/catch tanto en el proxy como en authz, y fallar CERRADO.
<!-- tags: supabase, auth, nextjs, performance | created: 2026-06-01 -->

### fix-20260601-supabase-role-hook
> `custom_access_token_hook(event jsonb) returns jsonb` expone profiles.role
> como claim `user_role`. El Auth server lo corre como rol `supabase_auth_admin`:
> `grant execute ... to supabase_auth_admin` + `revoke ... from anon,
> authenticated, public` (no exponer vía RPC) + grant select y policy en la
> tabla de roles. Endurecer SIEMPRE: guard del cast `(event->>'user_id')::uuid`
> y `coalesce(event->'claims','{}')` — un evento malformado que lance ABORTA la
> emisión de token para TODOS los logins. Local: habilitar en config.toml
> `[auth.hook.custom_access_token]` (uri `pg-functions://postgres/public/...`).
> Remoto: toggle MANUAL en Dashboard > Authentication > Hooks (MCP no lo expone).
> authz lee el claim con fallback a profiles → funciona aunque el toggle remoto
> esté apagado (el claim es pura optimización).
<!-- tags: supabase, auth, security, rls | created: 2026-06-01 -->

### fix-20260601-supabase-start-vs-reset
> `supabase start` restaura el VOLUMEN previo (backup de `supabase stop`) y NO
> re-aplica migraciones nuevas añadidas desde el último reset → la función/tabla
> nueva "no existe". Tras añadir una migración, correr **`supabase db reset`**
> (recrea la DB y aplica 0001..N + seed) antes de `supabase test db`.
<!-- tags: supabase, cli, testing | created: 2026-06-01 -->

### fix-20260601-vitest-path-alias
> tsconfig define `@/* -> ./src/*`, pero vitest NO lo hereda. Añadir a
> `vitest.config.ts`: `resolve.alias["@"] = fileURLToPath(new URL("./src",
> import.meta.url))`. Sin esto, importar `@/...` en un test falla con "Cannot
> find package". Importar `next/headers` desde un módulo bajo test es inofensivo
> en vitest si no se LLAMA (solo se evalúa el import).
<!-- tags: testing, vitest, build | created: 2026-06-01 -->

### fix-20260601-migration-renumber
> Numeración real de migraciones (el plan original difería): 0001 extensions,
> 0002 core_tables, 0003 rls_policies, 0004 harden_functions (step03), **0005
> role_jwt_hook (step04)**, **0006 report_idempotency_and_storage (step05)**,
> **0007 visibility_trigger (step08)**. El hook de rol, diferido de step03, tomó
> 0005; idempotency+bucket de reportes tomó 0006 en step05, empujando el trigger
> de visibilidad a 0007.
<!-- tags: supabase, migrations, planning | created: 2026-06-01 -->

### fix-20260601-route-group-url
> Un route group `(panel)` NO añade segmento de URL. Para que exista `/panel`
> (lo exige la AC) el page va en `src/app/(panel)/panel/page.tsx`; el gate
> `src/app/(panel)/layout.tsx` envuelve todo el grupo. Poner page directo en
> `(panel)/page.tsx` mapea a `/` y COLISIONA con `app/page.tsx`.
<!-- tags: nextjs, routing | created: 2026-06-01 -->

### fix-20260601-supabase-publishable-key
> Supabase migra de claves `anon`/`service_role` a `sb_publishable_*` /
> `sb_secret_*`. Los docs nuevos usan `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
> Aquí seguimos con `NEXT_PUBLIC_SUPABASE_ANON_KEY` (ya provisionada en Vercel
> prod en step02); ambas funcionan en el periodo de transición. Migrar a
> publishable cuando convenga (es la dirección futura).
<!-- tags: supabase, env | created: 2026-06-01 -->

### fix-20260602-supabase-js-node20-ws
> `createClient` de @supabase/supabase-js construye un `RealtimeClient` de forma
> EAGER; en Node < 22 sin `WebSocket` global, su constructor LANZA
> ("Node.js 20 detected without native WebSocket support") al crear el cliente,
> aunque nunca abras un canal. El cliente admin (write path) no usa Realtime →
> pasarle un transporte inerte `NoopWebSocket` (que solo lanza al conectar)
> satisface el lookup sin añadir `ws`. Aplica a CUALQUIER cliente service-role
> en serverless Node 20 (Vercel) — step06/07 lo necesitarán. Ver src/lib/supabase/admin.ts.
<!-- tags: supabase, nextjs, build, node | created: 2026-06-02 -->

### fix-20260602-write-path-signed-upload
> DECISIÓN de arquitectura (actualiza diseño §5.3): TODA la media (imagen Y video)
> sube por **signed upload URL directo al bucket privado** que emite
> `POST /api/reports`, NO bytes-a-través-de-/api/media. El strip de EXIF pasa a
> proceso async server-side (step07 lee el raw → limpia → marca processed). Razón:
> honra AC3 ("URL firmada") uniforme + las Route Handlers de Vercel serverless
> tienen tope de body (~4.5MB) y las imágenes llegan a 10MB → bytes-por-el-handler
> es inviable. Idempotencia + multi-fila atómica via RPC Postgres `create_report`
> (SECURITY DEFINER, search_path='', execute solo a service_role) con
> `on conflict (idempotency_key) where ... do nothing` — una transacción, sin
> huérfanos, sin race de replay.
<!-- tags: supabase, vercel, storage, architecture | created: 2026-06-02 -->

### fix-20260602-nullish-empty-header
> Trampa: `request.headers.get("X") ?? undefined` devuelve `""` para un header
> presente-pero-vacío (`??` solo atrapa null/undefined, NO string vacío). Un
> `Idempotency-Key:` en blanco se guardaba como key real `""` → el índice único
> parcial lo trata como valor → el 2º request con header vacío de CUALQUIER cliente
> chocaba (23505) y recibía el reporte+upload URLs del primero (colisión cross-user).
> Fix: `const raw = h.get("X")?.trim(); const key = raw ? raw : undefined;`. Normalizar
> SIEMPRE headers de idempotencia/capacidad antes de persistir.
<!-- tags: nextjs, security, idempotency | created: 2026-06-02 -->

### fix-20260602-jsonb-recordset-ordinality
> `WITH ORDINALITY` rechaza una lista de definición de columnas pegada a
> `jsonb_to_recordset(...) AS (...)`. La forma correcta es
> `ROWS FROM (jsonb_to_recordset(p) AS (col type, ...)) WITH ORDINALITY AS m(col, ..., ord)`.
> Útil para insertar N filas desde un array jsonb preservando el orden del cliente
> en UNA sentencia (batch atómico). Detectado solo corriendo la RPC contra PG real.
<!-- tags: postgres, supabase, sql | created: 2026-06-02 -->

### fix-20260602-upstash-window-construction-throw
> `Ratelimit.slidingWindow(max, window)` parsea el `window` (Duration) en
> CONSTRUCCIÓN, no en `.limit()`. Un valor que el regex `^\d+\s?(ms|s|m|h|d)$`
> rechace ("10  m" doble espacio, "10 minutes", "10 M", "10m ") LANZA al construir
> → si el limiter está en un singleton lazy con fail-open, se desactiva el
> rate-limit PARA SIEMPRE y solo deja un console.warn por request (indistinguible
> de un blip transitorio). SIEMPRE validar el window contra el regex y caer a
> default; floor de max ≥ 1. El fail-open es para outages TRANSITORIOS, no para
> tapar errores de config. Ver src/lib/rateLimit.ts.
<!-- tags: upstash, ratelimit, config, security | created: 2026-06-02 -->

### fix-20260602-xff-first-hop-spoofable
> El PRIMER hop de `x-forwarded-for` lo controla el cliente → keyear el rate-limit
> por él permite rotarlo y evadir el límite. En Vercel, confiar en el hop de
> PLATAFORMA: `x-vercel-forwarded-for` / `x-real-ip` (no reenviados desde el
> cliente) o el ÚLTIMO hop de XFF (el que añade el proxy). `split(",")[0]` es el
> antipatrón. Sin IP determinable → bucket "unknown" compartido (en Vercel XFF
> siempre está, así que es inalcanzable en prod; el captcha igual amuralla).
> Ver clientIp() en src/app/api/reports/route.ts.
<!-- tags: nextjs, vercel, security, ratelimit | created: 2026-06-02 -->
