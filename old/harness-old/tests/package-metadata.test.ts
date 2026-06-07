import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("package metadata", () => {
  test("published workspace packages include the dist files referenced by exports", async () => {
    const core = await readPackage("packages/core/package.json");
    expect(core.exports["."]).toMatchObject({
      import: "./dist/index.js",
      types: "./dist/index.d.ts"
    });
    expect(core.files).toEqual(expect.arrayContaining(["dist", "src"]));

    const sqlite = await readPackage("packages/store-sqlite/package.json");
    expect(sqlite.files).toEqual(expect.arrayContaining(["dist", "src", "drizzle"]));
  });

  test("CLI package exposes the built executable bin", async () => {
    const cli = await readPackage("apps/harness-cli/package.json");
    expect(cli.bin).toEqual({ harness: "./dist/bin.js" });
    expect(cli.files).toEqual(expect.arrayContaining(["dist", "src"]));
    expect(cli.scripts.build).toContain("chmod-package-bins");
  });
});

async function readPackage(relativePath: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
}
