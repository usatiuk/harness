import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export const LITELLM_IMAGE =
  "ghcr.io/berriai/litellm:v1.103.2@sha256:f63fb81b831b170ec16851e23c36ac5bf52ef106b271406429524a2ed730bbfd";
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
const execute = promisify(execFile);
async function docker(...args: string[]) {
  // Errors from process libraries include command arguments. Keep fixture keys out of diagnostics.
  try {
    return (await execute("docker", args, { windowsHide: true, timeout: 120_000 })).stdout.trim();
  } catch {
    throw new Error(`Docker fixture operation '${args[0]}' failed`);
  }
}

/** Isolated gateway and database; never touches existing Docker services or user credentials. */
export async function dockerGateway(modelList: unknown[]) {
  const name = `harness-litellm-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "harness-litellm-docker-"));
  const gateway = `${name}-gateway`;
  const db = `${name}-db`;
  const master = `sk-fixture-${randomUUID()}`;
  const owned: string[] = [];
  let network = false;
  async function close() {
    const results = await Promise.allSettled(
      owned.map((container) => docker("rm", "-f", container)),
    );
    if (network) await docker("network", "rm", name);
    await rm(directory, { recursive: true, force: true });
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  try {
    await writeFile(
      join(directory, "config.yaml"),
      JSON.stringify({
        model_list: modelList,
        general_settings: { master_key: master, store_model_in_db: false },
        router_settings: {
          num_retries: 0,
          enable_pre_call_checks: true,
          optional_pre_call_checks: ["encrypted_content_affinity"],
        },
        litellm_settings: { set_verbose: false },
      }),
    );
    await docker("network", "create", name);
    network = true;
    await docker(
      "run",
      "-d",
      "--name",
      db,
      "--network",
      name,
      "-e",
      "POSTGRES_DB=litellm",
      "-e",
      "POSTGRES_USER=fixture",
      "-e",
      "POSTGRES_PASSWORD=fixture-only",
      POSTGRES_IMAGE,
    );
    owned.push(db);
    await docker(
      "run",
      "-d",
      "--name",
      gateway,
      "--network",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::4000",
      "-v",
      `${join(directory, "config.yaml")}:/app/config.yaml:ro`,
      "-e",
      `DATABASE_URL=postgresql://fixture:fixture-only@${db}:5432/litellm`,
      LITELLM_IMAGE,
      "--config",
      "/app/config.yaml",
      "--port",
      "4000",
    );
    owned.push(gateway);
    const mapping = await docker("port", gateway, "4000/tcp");
    const port = /127\.0\.0\.1:(\d+)/.exec(mapping)?.[1];
    if (!port) throw new Error("Missing gateway fixture port");
    const url = `http://127.0.0.1:${port}`;
    const startup = AbortSignal.timeout(90_000);
    while (true) {
      startup.throwIfAborted();
      try {
        const response = await fetch(`${url}/health/readiness`, {
          headers: { authorization: `Bearer ${master}` },
          signal: AbortSignal.any([startup, AbortSignal.timeout(2000)]),
        });
        await response.body?.cancel();
        if (response.ok) break;
      } catch {
        startup.throwIfAborted();
      }
      await delay(250, undefined, { signal: startup });
    }
    return {
      url,
      close,
      async key(models: string[]) {
        const response = await fetch(`${url}/key/generate`, {
          method: "POST",
          headers: { authorization: `Bearer ${master}`, "content-type": "application/json" },
          body: JSON.stringify({ models }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Virtual key fixture returned HTTP ${response.status}`);
        const result = (await response.json()) as { key?: unknown };
        if (typeof result.key !== "string") throw new Error("Missing virtual key");
        return result.key;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
