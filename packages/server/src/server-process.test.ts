import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { appSettingsRequest, appSettingsUpdateRequest } from "./client-protocol.ts";

function launch(home: string) {
  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      fileURLToPath(new URL("./bin.ts", import.meta.url)),
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HARNESS_HOME: home,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENCODE_API_KEY: "",
        MISTRAL_API_KEY: "",
        MISTRAL_VIBE_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const client = new HarnessClient({
    connection: createNdjsonMessageConnection(child.stdout, child.stdin),
    client: { name: "server-ownership-test", version: "1" },
  });
  return {
    child,
    client,
    exited,
    diagnostics: () => diagnostics,
    initialize: async () => {
      try {
        await client.start();
      } catch (error) {
        await exited;
        throw new Error(`Server startup failed: ${diagnostics}`, { cause: error });
      }
    },
  };
}

async function withServers(
  run: (home: string, start: () => ReturnType<typeof launch>) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "harness-server-ownership-"));
  const launched: ReturnType<typeof launch>[] = [];
  const start = () => {
    const server = launch(home);
    launched.push(server);
    return server;
  };
  try {
    await run(home, start);
  } finally {
    for (const server of launched) {
      server.client.closeConnection();
      if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill();
      await server.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
}

describe("production server process ownership", () => {
  it("excludes another server while the first owns the home", async () => {
    await withServers(async (_home, start) => {
      const first = start();
      await first.initialize();
      const second = start();
      await expect(second.client.start()).rejects.toThrow();
      expect(await second.exited).not.toBe(0);
      expect(second.diagnostics()).toContain("already in use by another server");
      first.client.closeConnection();
      expect(await first.exited).toBe(0);
    });
  }, 20_000);

  it("serves safe settings and preserves updates after graceful quit", async () => {
    await withServers(async (home, start) => {
      await writeFile(
        join(home, "settings.json"),
        JSON.stringify({
          model: { provider: "demo", model: "demo-1" },
          plugins: {
            "auto-approval": {
              enabled: false,
              model: { provider: "demo", model: "demo-1", preset: "low" },
            },
          },
        }),
      );
      const first = start();
      await first.initialize();
      const config = await first.client.peer.request(appSettingsRequest, {});
      expect(config.home).toBe(home);
      expect(config.providers.map(({ id }) => id)).toEqual([
        "openai",
        "anthropic",
        "opencode-go",
        "openai-codex",
        "mistral-api",
        "mistral-vibe",
      ]);
      expect(JSON.stringify(config)).not.toContain("apiKey");
      expect(config.settings.autoApproval).toEqual({
        enabled: false,
        model: { provider: "demo", model: "demo-1", preset: "low" },
      });
      await first.client.peer.request(appSettingsUpdateRequest, {
        model: { provider: "demo", model: "demo-1", preset: "high" },
        approval: { inWorkspace: "ask", outOfWorkspace: "deny" },
        autoApproval: { ...config.settings.autoApproval, enabled: true },
        sandbox: "local",
      });
      first.client.closeConnection();
      expect(await first.exited).toBe(0);
      const reopened = start();
      await reopened.initialize();
      expect(
        (await reopened.client.peer.request(appSettingsRequest, {})).settings.model?.preset,
      ).toBe("high");
      const updated = (await reopened.client.peer.request(appSettingsRequest, {})).settings;
      expect(updated.autoApproval).toEqual({
        enabled: true,
        model: { provider: "demo", model: "demo-1", preset: "low" },
      });
      await reopened.client.peer.request(appSettingsUpdateRequest, {
        ...updated,
        autoApproval: { enabled: false, model: null },
      });
      const cleared = (await reopened.client.peer.request(appSettingsRequest, {})).settings;
      expect(cleared.autoApproval).toEqual({ enabled: false, model: null });
      expect(cleared.model).toEqual(updated.model);
      expect(cleared.approval).toEqual(updated.approval);
      reopened.client.closeConnection();
      expect(await reopened.exited).toBe(0);
    });
  }, 20_000);

  it("releases the home after a crash", async () => {
    await withServers(async (_home, start) => {
      const first = start();
      await first.initialize();
      first.child.kill("SIGKILL");
      await first.exited;
      const afterCrash = start();
      await afterCrash.initialize();
      expect(
        (await afterCrash.client.models()).models.some((model) => model.provider === "demo"),
      ).toBe(true);
      afterCrash.client.closeConnection();
      expect(await afterCrash.exited).toBe(0);
    });
  }, 20_000);
});
