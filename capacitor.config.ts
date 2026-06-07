import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor shell config (step15 Phase A — SCEN-005).
 *
 * This file is consumed ONLY by the `@capacitor/cli` at build/sync time
 * (`npx cap add android`, `cap sync`). It is NOT imported by any app code, so it
 * never enters the Next.js bundle.
 *
 * `server.url` makes the native WebView load the LIVE deployed Next app instead
 * of a static export — the whole UI (including the capture form and its native
 * camera/GPS branch) runs against production. `webDir` ("public") is only a
 * fallback bundle for when no `server.url` is reachable.
 *
 * IMPORTANT: `server.url` MUST point at the real production URL. It is read from
 * `NEXT_PUBLIC_APP_URL` at sync time; the literal below is a placeholder for
 * local sync until the Vercel production domain is final. `cleartext: false`
 * forbids plain HTTP — production is HTTPS only.
 */
const config: CapacitorConfig = {
  appId: "com.evidencialo.app",
  appName: "evidencialo",
  webDir: "public",
  server: {
    url: process.env.NEXT_PUBLIC_APP_URL || "https://evidencialo.vercel.app",
    cleartext: false,
  },
};

export default config;
