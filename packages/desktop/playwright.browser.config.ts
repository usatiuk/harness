import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "./test-results/browser",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  },
});
