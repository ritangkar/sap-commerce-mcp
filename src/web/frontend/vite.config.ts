import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// Built output is served by the local backend (src/web/backend) from dist/web/static.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: resolve(here, "../../../dist/web/static"), emptyOutDir: true, sourcemap: false, target: "es2022" }
});
