import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const sharedTestOptions = {
  pool: "forks" as const,
  testTimeout: 20000,
  hookTimeout: 20000,
  teardownTimeout: 20000
};

const project = (name: string, include: string[], timeoutOptions = sharedTestOptions) => ({
  extends: true as const,
  test: {
    name,
    include,
    ...timeoutOptions
  }
});

export default defineConfig({
  resolve: {
    alias: [
      { find: "@harness/cli", replacement: path.join(root, "apps/cli/src/index.ts") },
      { find: /^@harness\/([^/]+)$/u, replacement: path.join(root, "packages/$1/src/index.ts") }
    ]
  },
  test: {
    ...sharedTestOptions,
    projects: [
      project("protocol", ["packages/protocol/test/**/*.test.ts"]),
      project("core", ["packages/core/test/**/*.test.ts"]),
      project("testkit", ["packages/testkit/test/**/*.test.ts"]),
      project("store-sqlite", ["packages/store-sqlite/test/**/*.test.ts"]),
      project("auth-openai", ["packages/auth-openai/test/**/*.test.ts"]),
      project("model-openai-common", ["packages/model-openai-common/test/**/*.test.ts"]),
      project("cli", ["apps/cli/test/**/*.test.ts"]),
      project("e2e", ["e2e/**/*.test.ts"], { ...sharedTestOptions, testTimeout: 30000 }),
      project("live", ["packages/**/live/**/*.test.ts"], { ...sharedTestOptions, testTimeout: 60000 })
    ]
  }
});
