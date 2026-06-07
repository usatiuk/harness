import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve @harness/* to source.
  resolve: {
    conditions: ["development"],
  },
  // .tsx tests need no JSX config: Vitest's oxc transform applies the automatic runtime.
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
    passWithNoTests: true,
    server: {
      deps: {
        inline: [/^@harness\//],
      },
    },
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
    },
  },
});
