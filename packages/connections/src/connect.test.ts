import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureLocalServer } from "./connect.ts";
import { canonicalHome, privateRuntimeDirectory } from "./local.ts";

it("reports only bounded diagnostics from the current failed startup, including retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-startup-error-"));
  // Let the production home creator establish ownership, including elevated Windows.
  const home = await canonicalHome(join(root, "home"));
  const directory = await privateRuntimeDirectory(home);
  const log = join(directory, "startup.log");
  await writeFile(log, "stale failure\n");
  try {
    for (const diagnostic of ["Unsupported Harness settings format: version 1 required", ""]) {
      await expect(
        ensureLocalServer(home, {
          executable: process.execPath,
          args: ["-e", `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1`],
        }),
      ).rejects.toMatchObject({
        message: `Server startup failed (exit 1); see ${log}${diagnostic ? `\n${diagnostic}` : ""}`,
      });
    }
    await expect(
      ensureLocalServer(home, {
        executable: process.execPath,
        args: [
          "-e",
          'process.stderr.write("x".repeat(16384) + "failure tail"); process.exitCode = 1',
        ],
      }),
    ).rejects.toThrow(
      `Server startup failed (exit 1); see ${log}\n${"x".repeat(8180)}failure tail`,
    );
    expect(await readFile(log, "utf8")).toContain("stale failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
