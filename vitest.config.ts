import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve @harness/* to source.
  resolve: {
    conditions: ["development"],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
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
