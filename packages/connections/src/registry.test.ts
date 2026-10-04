import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { readClientConfig, removeHost, saveHost, updateClientConfig } from "./registry.ts";
const exec = promisify(execFile);

it("starts with Local and preserves simultaneous registry edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-registry-"));
  const path = join(directory, "client.json");
  try {
    expect((await readClientConfig(path)).hosts.map((host) => host.label)).toEqual(["Local"]);
    await Promise.all(
      ["workstation", "laptop", "build"].map((id) =>
        saveHost(
          {
            kind: "ssh",
            id,
            label: id,
            destination: id,

            runtime: { source: "development" },
          },
          path,
        ),
      ),
    );
    const saved = await updateClientConfig(
      (config) => ({ ...config, selectedHostId: "laptop", desktop: { keepServerRunning: false } }),
      path,
    );
    expect(saved.hosts.map((host) => host.id).sort()).toEqual([
      "build",
      "laptop",
      "local",
      "workstation",
    ]);
    expect((await removeHost("laptop", path)).selectedHostId).toBe("local");
    expect(() => removeHost("local", path)).toThrow("Local cannot be removed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("coordinates simultaneous registry updates from separate client processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-registry-process-"));
  const path = join(directory, "client.json");
  try {
    await Promise.all(
      ["desktop", "tui", "another-tui"].map((id) =>
        exec(
          process.execPath,
          [
            "--conditions=development",
            "--import=tsx",
            "packages/connections/src/registry-fixture.ts",
            path,
            id,
          ],
          { windowsHide: true },
        ),
      ),
    );
    expect((await readClientConfig(path)).hosts.map((host) => host.id).sort()).toEqual([
      "another-tui",
      "desktop",
      "local",
      "tui",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it("reports malformed configuration instead of replacing it with defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-registry-"));
  const path = join(directory, "client.json");
  try {
    await writeFile(path, '{"version":100}');
    await expect(readClientConfig(path)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
