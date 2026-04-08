import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      ".tmp-*/**",
      "eslint.config.js",
      "out/**",
      "tests/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.es2024,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreIIFE: true,
          ignoreVoid: true,
        },
      ],
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
);
