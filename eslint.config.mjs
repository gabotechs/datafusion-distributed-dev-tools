import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/target/**",
      "CODE_QUALITY_COMMENTS.md",
    ],
  },
  {
    files: ["*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          "./benchmark-bot/tsconfig.json",
          "./benchmark-bot/tsconfig.pulumi.json",
          "./benchmarks-remote/tsconfig.json",
          "./benchmarks-remote/pulumi/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: {
      // node:test registers these promises with the test runner itself.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
];
