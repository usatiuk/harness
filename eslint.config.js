import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/target/**",
      "**/gen/**",
      "**/resources/**",
      "**/test-results/**",
      "old/**",
      "coverage/**",
      "release/output/**",
      ".harness-dev/**",
      ".native-dev/**",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    // Playwright requires a destructured first parameter even when native tests
    // own their WebView and use none of its browser fixtures.
    files: ["packages/desktop/tests/**/*.spec.ts"],
    rules: { "no-empty-pattern": "off" },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Our contracts are Promise-based; implementing them as `async` without an
      // `await` is intentional, so thrown errors surface as rejections.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // React Hooks rules for the Ink TUI components.
    ...reactHooks.configs.flat["recommended-latest"],
    files: ["**/*.tsx"],
  },
  {
    // The N-API loader is CommonJS so Node can load a native .node module.
    files: ["packages/native/index.cjs"],
    languageOptions: { globals: { require: "readonly", module: "readonly", exports: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Config files aren't in any package's tsconfig.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
