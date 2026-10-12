import { defineConfig } from "vitest/config";

// Opt-in, read-only checks against a real local HAC. Never part of `npm test`.
export default defineConfig({
  test: { globals: true, environment: "node", include: ["tests/live/**/*.test.ts"], testTimeout: 60000 }
});
