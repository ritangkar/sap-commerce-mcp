import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off"
    }
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "off" }
  },
  {
    // The shared core and the web backend must never reach for a raw HTTP/exec API.
    files: ["src/core/**/*.ts", "src/ai/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:child_process", "child_process", "node:fs", "fs", "node:fs/promises", "fs/promises"] }]
    }
  }
);
