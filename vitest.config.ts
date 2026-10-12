import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/live/**"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20000
  }
});
