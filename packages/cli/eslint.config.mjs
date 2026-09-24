import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  // 打包脚本是直接用 node 运行的 .mjs
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  {
    rules: {
      // `_` 前缀表示刻意不使用，不报未使用（与 apps/web 一致）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
]);
