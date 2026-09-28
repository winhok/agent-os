import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/**", "data/**", "logs/**", ".pnpm-store/**", ".agents/**", ".claude/**", ".codex/**"]),
  {
    files: ["**/*.{js,mjs,ts}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Feishu cards intentionally use full-width spaces inside templates.
      "no-irregular-whitespace": ["error", { skipTemplates: true }],
    },
  },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Raw CLI JSONL and SDK callbacks have dynamic payloads at these boundaries.
    files: ["src/cli/spawn-cli.ts", "src/im/lark.ts", "src/probe-cli.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  eslintConfigPrettier,
);
