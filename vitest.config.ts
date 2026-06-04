import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror the tsconfig `@/* -> ./src/*` path alias so tests resolve app imports.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // src/** holds app/service tests; supabase/functions/** holds the PORTABLE
    // Edge-function modules (mp4.ts, retry.ts) — plain TS, vitest-runnable. The
    // Deno handler (index.ts) has no .test.ts and is verified via serve instead.
    include: ["src/**/*.test.ts", "supabase/functions/**/*.test.ts"],
  },
});
