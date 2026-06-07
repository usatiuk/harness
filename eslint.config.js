import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "old/**", "coverage/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
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
    // Config files aren't in any package's tsconfig.
    files: ["**/*.js", "**/*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
