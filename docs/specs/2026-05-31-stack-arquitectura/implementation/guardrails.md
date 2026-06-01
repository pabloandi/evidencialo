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
