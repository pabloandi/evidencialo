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
    // Default env is node (services, route handlers). Component tests that need
    // a DOM opt in per-file via a `// @vitest-environment jsdom` docblock
    // (CaptureForm.test.tsx) — keeping the node default fast for everything else.
    environment: "node",
    // src/** holds app/service tests (.test.ts) and component tests (.test.tsx);
    // supabase/functions/** holds the PORTABLE Edge-function modules (mp4.ts,
    // retry.ts) — plain TS, vitest-runnable. The Deno handler (index.ts) has no
    // .test.ts and is verified via serve instead.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "supabase/functions/**/*.test.ts",
    ],
  },
});
