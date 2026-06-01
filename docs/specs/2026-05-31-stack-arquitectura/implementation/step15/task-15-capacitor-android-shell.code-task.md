## Status: PENDING
## Blocked-By: step07/task-07-media-api-exif-strip.code-task.md
## Completed:

# Task: Shell Android (Capacitor) con cámara/GPS nativos

## Description
Empaquetar la web app como aplicación Android con Capacitor, apuntando a la URL
de producción (`server.url`), e integrar captura nativa de cámara y geolocalización
en el flujo de envío, con fallback a las APIs web.

## Background
Sin modo offline en el MVP, Capacitor con `server.url` muestra la web en vivo y
expone los plugins nativos vía el puente. Esto da mejor cámara/GPS que las APIs
web y mantiene una sola base de código. Fallback documentado: bundle estático.

## Reference Documentation
**Required:**
- Design: `docs/specs/2026-05-31-stack-arquitectura-design.md` (§2 Android)

**Additional References:**
- Plan: `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md` (Paso 15)
- Skill: `electron` (no aplica) — usar docs de Capacitor vigentes.

**Note:** You MUST read the detailed design before implementing. Verifica la API
de Capacitor (`@capacitor/camera`, `@capacitor/geolocation`, `server.url`) en docs
vigentes.

## Technical Requirements
1. `capacitor.config.ts` con `server.url` a producción; proyecto `android/`
   generado.
2. Integrar `@capacitor/camera` y `@capacitor/geolocation` en `CaptureForm` con
   fallback a APIs web cuando no se ejecuta en Capacitor.
3. Build de APK funcional.

## Dependencies
- **Paso 07 completado**: el camino de envío de media (al que la app llama) existe.
- **App desplegada**: la URL de producción a la que apunta `server.url`.

## Implementation Approach
1. Añadir Capacitor y generar el proyecto Android.
2. Configurar `server.url` a producción.
3. Integrar cámara/GPS nativos en `CaptureForm` con detección de entorno.
4. Generar y probar el APK.

## Acceptance Criteria
1. **Envío end-to-end desde Android**
   - Given la app Android instalada
   - When el usuario captura una foto y envía el reporte
   - Then el reporte llega a la misma API y sigue el flujo de E1 (sin EXIF,
     visible al procesarse).

2. **Captura nativa con fallback**
   - Given la app ejecutándose en Capacitor
   - When el usuario abre la captura
   - Then usa cámara/GPS nativos; en navegador web usa las APIs web.

3. **Build de APK**
   - Given el proyecto Capacitor
   - When se ejecuta el build de Android
   - Then produce un APK instalable.

## Metadata
- **Complexity**: Medium
- **Estimated Effort**: M
- **Labels**: android, capacitor, mobile, capture
- **Required Skills**: Capacitor, Android build, Next.js
- **Related Tasks**: step07
- **Step**: 15 of 15
- **Files to Modify**: `capacitor.config.ts`, `src/components/capture/CaptureForm.tsx`, `package.json`
- **Files to Read**: `docs/specs/2026-05-31-stack-arquitectura-design.md`, `docs/specs/2026-05-31-stack-arquitectura/implementation/plan.md`
- **Context Estimate**: M
- **Scenario-Strategy**: required
