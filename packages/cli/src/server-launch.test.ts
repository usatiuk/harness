import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { selectStdioServer } from "./server-launch.ts";
import {
  canonicalHome,
  ensureLocalServer,
  stopServer,
  readServerSelection,
} from "@harness/connections/node";

afterEach(() => vi.unstubAllEnvs());

it("keeps the selected release when an isolated launch conflicts with its shared owner", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "harness-cli-live-selection-"));
  const home = await canonicalHome(join(temporary, "home"));
  vi.stubEnv("HARNESS_HOME", home);
  const target =
    process.platform === "win32"
      ? "windows-x64"
      : process.platform === "darwin"
        ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
        : "linux-x64-glibc";
  const initial = `0.1.0-${target}`;
  const rebuilt = `0.2.0-${target}`;
  const launch = {
    executable: process.execPath,
    args: [
      "--conditions=development",
      "--import=tsx",
      fileURLToPath(new URL("../../server/src/bin.ts", import.meta.url)),
      "--background",
    ],
    selection: initial,
  };
  const host = await ensureLocalServer(home, launch);
  let stopped = false;
  try {
    await expect(selectStdioServer({ ...launch, selection: rebuilt })).rejects.toThrow(
      "shared Local server is running",
    );
    expect((await readServerSelection(home))?.directory).toBe(initial);
    host.close();
    await stopServer(host.identity);
    stopped = true;
    await selectStdioServer({ ...launch, selection: rebuilt });
    expect((await readServerSelection(home))?.directory).toBe(rebuilt);
    await expect(selectStdioServer(launch)).rejects.toThrow("Selected server changed");
    expect((await readServerSelection(home))?.directory).toBe(rebuilt);
  } finally {
    host.close();
    if (!stopped) await stopServer(host.identity);
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
