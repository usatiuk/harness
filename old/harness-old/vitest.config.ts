import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@harness/harness-cli", replacement: path.join(root, "apps/harness-cli/src/index.ts") },
      { find: /^@harness\/([^/]+)$/u, replacement: path.join(root, "packages/$1/src/index.ts") }
    ]
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000
  }
});
