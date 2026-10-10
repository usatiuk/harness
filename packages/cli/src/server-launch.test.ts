import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi, onTestFailed } from "vitest";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { localServerLaunch, selectStdioServer } from "./server-launch.ts";
import {
  canonicalHome,
  ensureLocalServer,
  stopServer,
  readServerSelection,
} from "@harness/connections/node";

afterEach(() => vi.unstubAllEnvs());

it("requires the selected server's captured runtime instead of the CLI runtime", () => {
  vi.stubEnv("HARNESS_SERVER_ENTRY", "/server/server.mjs");
  vi.stubEnv("HARNESS_SERVER_PAYLOAD", "/server/0.2.0-windows-x64");
  vi.stubEnv("HARNESS_SERVER_NODE", undefined);
  expect(() => localServerLaunch("stdio")).toThrow("did not capture its server runtime");
});

it("runs the CLI stdio command through its selected server executable and admission identity", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "harness-cli-selected-"));
  const home = await canonicalHome(join(temporary, "home"));
  const target =
    process.platform === "win32"
      ? "windows-x64"
      : process.platform === "darwin"
        ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
        : "linux-x64-glibc";
  const directory = `0.2.0-${target}`;
  const payload = join(home, "server", directory);
  const node = join(
    temporary,
    process.platform === "win32" ? "selected-node.exe" : "selected-node",
  );
  const entry = join(payload, "server.mjs");
  const selection = { formatVersion: 1, directory };
  await mkdir(payload, { recursive: true });
  await cp(process.execPath, node);
  await writeFile(join(home, "server/current.json"), JSON.stringify(selection));
  const server = new URL("../../server/src/bin.ts", import.meta.url).href;
  await writeFile(
    entry,
    `console.error(JSON.stringify({ executable: process.execPath }));\nawait import(${JSON.stringify(server)});\n`,
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./bin.ts", import.meta.url)), "server", "--stdio"],
    {
      cwd: temporary,
      env: {
        ...process.env,
        NODE_OPTIONS: `--conditions=development --import=${pathToFileURL(fileURLToPath(import.meta.resolve("tsx"))).href}`,
        HARNESS_HOME: home,
        HARNESS_SERVER_ENTRY: entry,
        HARNESS_SERVER_PAYLOAD: payload,
        HARNESS_SERVER_NODE: node,
        HARNESS_SERVER_SELECTION: "stale-inherited-selection",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  onTestFailed(() => console.error(diagnostic));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const client = new HarnessClient({
    connection: createNdjsonMessageConnection(child.stdout, child.stdin),
    client: { name: "selected-cli-test", version: "0.1.0" },
  });
  try {
    await client.start();
    const conversation = await client.create({ cwd: temporary });
    expect(conversation.workspaceRoot).toBe(temporary);
    client.closeConnection();
    child.stdin.end();
    expect(await exited, diagnostic).toBe(0);
    expect(diagnostic).toContain(JSON.stringify({ executable: node }));
    expect(JSON.parse(await readFile(join(home, "server/current.json"), "utf8"))).toEqual(
      selection,
    );
  } finally {
    client.closeConnection();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

it("keeps a live source owner's selection when an isolated rebuilt launch is rejected", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "harness-cli-live-selection-"));
  const home = await canonicalHome(join(temporary, "home"));
  vi.stubEnv("HARNESS_HOME", home);
  const target =
    process.platform === "win32"
      ? "windows-x64"
      : process.platform === "darwin"
        ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
        : "linux-x64-glibc";
  const initial = `dev-${target}-${"a".repeat(64)}`;
  const rebuilt = `dev-${target}-${"b".repeat(64)}`;
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
  } finally {
    host.close();
    if (!stopped) await stopServer(host.identity);
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
