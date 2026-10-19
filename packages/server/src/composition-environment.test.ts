import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { initializeUserShellEnvironment } from "@harness/execution";
import { nativeSandboxAvailable } from "@harness/sandbox";
import { SqliteStore } from "@harness/store-sqlite";
import { buildServerComposition, buildServerHarness } from "./index.ts";
import { appSettingsRequest } from "./client-protocol.ts";

vi.mock("@harness/execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@harness/execution")>()),
  initializeUserShellEnvironment: vi.fn(async () => {}),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-owner-environment-"));
  roots.push(root);
  const home = join(root, ".harness");
  await mkdir(home, { mode: 0o700 });
  vi.stubEnv("HARNESS_HOME", home);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
    vi.stubEnv(key, "");
  return { root, home };
}

it.skipIf(process.platform !== "linux")(
  "selects the native default from the initialized owner environment, not the GUI launch PATH",
  async () => {
    const { root } = await fixture();
    const bin = join(root, "bin");
    await mkdir(bin);
    // Substitute only the OS availability probe; no native execution is claimed here.
    await writeFile(join(bin, "bwrap"), '#!/bin/sh\n[ "$OWNER_ENV_READY" = yes ]\n', {
      mode: 0o700,
    });
    vi.stubEnv("PATH", "");
    vi.stubEnv("OWNER_ENV_READY", "no");
    expect(nativeSandboxAvailable()).toBe(false);
    vi.mocked(initializeUserShellEnvironment).mockImplementationOnce(async () => {
      process.env["PATH"] = bin;
      process.env["OWNER_ENV_READY"] = "yes";
    });
    const pair = createInProcessMessageConnectionPair();
    const harness = await buildServerHarness(pair.right);
    const client = new HarnessClient({
      connection: pair.left,
      client: { name: "probe-test", version: "1" },
    });
    try {
      await client.start();
      expect((await client.peer.request(appSettingsRequest, {})).settings.sandbox).toBe("native");
      expect((await client.create({})).config.plugins?.["sandbox"]).toMatchObject({
        backend: "native",
      });
    } finally {
      client.closeConnection();
      await harness.close();
    }
  },
);

it("keeps the original resolved home when startup changes HOME without an explicit HARNESS_HOME", async () => {
  const { root, home } = await fixture();
  const other = join(root, "different-home");
  await mkdir(join(other, ".harness"), { recursive: true });
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({ version: 1, instructions: "ORIGINAL SETTINGS" }),
  );
  await writeFile(
    join(other, ".harness", "settings.json"),
    JSON.stringify({ version: 1, instructions: "WRONG SETTINGS" }),
  );
  vi.stubEnv("HARNESS_HOME", undefined);
  vi.stubEnv("HOME", root);
  vi.mocked(initializeUserShellEnvironment).mockImplementationOnce(async () => {
    process.env["HOME"] = other;
  });
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "home-test", version: "1" },
  });
  try {
    await client.start();
    const settings = await client.peer.request(appSettingsRequest, {});
    expect(settings.home).toBe(home);
    expect((await client.create({})).config.instructions).toBe("ORIGINAL SETTINGS");
  } finally {
    client.closeConnection();
    await harness.close();
  }
});

it("releases database ownership when environment initialization fails before sandbox construction", async () => {
  const { home } = await fixture();
  vi.mocked(initializeUserShellEnvironment).mockRejectedValueOnce(
    new Error("startup fixture failed"),
  );
  await expect(buildServerComposition()).rejects.toThrow("startup fixture failed");
  const reopened = new SqliteStore(join(home, "store.db"), undefined, undefined, {
    exclusive: true,
  });
  reopened.close();
});
