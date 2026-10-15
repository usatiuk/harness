import { dockerTestEnvironment } from "./docker.test-support.ts";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { DockerGuardian } from "./docker-guardian.ts";

const execute = promisify(execFile);
it.runIf(process.env.HARNESS_DOCKER_INTEGRATION === "1")(
  "stops existing and later owned starts after server SIGKILL, isolates other owners, and hands over",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-guardian-test-"));
    for (const [key, value] of Object.entries(
      await dockerTestEnvironment(join(directory, "docker-client")),
    ))
      vi.stubEnv(key, value);
    const home = join(directory, "home");
    const guardian = new DockerGuardian(home);
    const script = join(directory, "server.mts");
    await writeFile(
      script,
      `import { DockerGuardian } from ${JSON.stringify(new URL("./docker-guardian.ts", import.meta.url).href)};\nconst guardian = new DockerGuardian(${JSON.stringify(home)});\nawait guardian.ensure();\nconsole.log('SERVER_READY');\nsetInterval(() => {}, 1000);\n`,
    );
    const server = spawn(process.execPath, ["--conditions=development", "--import=tsx", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const containers: string[] = [];
    let errors = "";
    server.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const run = async (...args: string[]) => (await execute("docker", args)).stdout.trim();
    const create = async (scope: string) => {
      const id = await run(
        "run",
        "-d",
        "--label",
        `harness.server=${scope}`,
        "node:24.21.0-alpine",
        "sleep",
        "600",
      );
      containers.push(id);
      return id;
    };
    try {
      await new Promise<void>((resolveReady, reject) => {
        server.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("SERVER_READY")) resolveReady();
        });
        server.once("exit", (code) => reject(new Error(`server exited ${code}: ${errors}`)));
      });
      const owned = await create(guardian.scope);
      const unrelated = await create(`other_${guardian.scope}`);
      server.kill("SIGKILL");
      await once(server, "exit");
      await vi.waitFor(
        async () =>
          expect(await run("inspect", "--format", "{{.State.Running}}", owned)).toBe("false"),
        { timeout: 20_000 },
      );
      const late = await create(guardian.scope);
      await vi.waitFor(
        async () =>
          expect(await run("inspect", "--format", "{{.State.Running}}", late)).toBe("false"),
        { timeout: 20_000 },
      );
      expect(await run("inspect", "--format", "{{.State.Running}}", unrelated)).toBe("true");
      await guardian.ensure();
      await run("start", owned);
      expect(await run("inspect", "--format", "{{.State.Running}}", owned)).toBe("true");
      await guardian.close();
      expect(await run("inspect", "--format", "{{.State.Status}}", owned)).toBe("exited");
      expect(await run("inspect", "--format", "{{.State.Running}}", unrelated)).toBe("true");
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await once(server, "exit");
      }
      const guardians = await run(
        "ps",
        "-aq",
        "--filter",
        `label=harness.guardian=${guardian.scope}`,
      );
      const ids = [...containers, ...guardians.split(/\s+/).filter(Boolean)];
      if (ids.length) await run("rm", "-f", ...ids);
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  90_000,
);

it.runIf(process.env.HARNESS_DOCKER_INTEGRATION === "1")(
  "reports guardian death and closes failed runtime without orphaning workspace",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-guardian-death-"));
    for (const [key, value] of Object.entries(
      await dockerTestEnvironment(join(directory, "docker-client")),
    ))
      vi.stubEnv(key, value);
    const { createSandboxRuntime } = await import("./plugin.ts");
    const { dockerSandboxConfigSchema } = await import("./config.ts");
    let failure: Error | undefined;
    const runtime = createSandboxRuntime(join(directory, "home"), (error) => {
      failure = error;
    });
    const run = async (...args: string[]) => (await execute("docker", args)).stdout.trim();
    const root = join(directory, "workspace");
    await mkdir(join(root, ".devcontainer"), { recursive: true });
    await writeFile(
      join(root, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ image: "node:24.21.0-alpine", remoteUser: "root" }),
    );
    const owner = { emit: () => {} };
    const environment = await runtime.environments.acquire(
      root,
      dockerSandboxConfigSchema.parse({}),
      owner,
    );
    let container: string | undefined;
    try {
      container = (await environment.start()).containerId;
      const id = await run("ps", "-q", "--filter", `label=harness.guardian=${environment.scope}`);
      await run("kill", id);
      await vi.waitFor(() => expect(failure?.message).toContain("Docker guardian exited"));
      await expect(runtime.close()).rejects.toThrow("Could not close Docker runtime");
      expect(await run("inspect", "--format", "{{.State.Running}}", container)).toBe("false");
    } finally {
      await environment.release(owner);
      if (container) await run("rm", "-f", container);
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);

it.runIf(process.env.HARNESS_DOCKER_INTEGRATION === "1")(
  "removes sidecar-only and network-only workspace remnants while preserving other owners",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-docker-remnants-"));
    for (const [key, value] of Object.entries(
      await dockerTestEnvironment(join(directory, "docker-client")),
    ))
      vi.stubEnv(key, value);
    const { DockerEnvironmentPool } = await import("./docker-environment.ts");
    const { workspaceProjectPrefix } = await import("./devcontainer.ts");
    const scope = new DockerGuardian(directory).scope;
    const root = join(directory, "workspace");
    const pool = new DockerEnvironmentPool(scope);
    const prefix = workspaceProjectPrefix(root, scope);
    const run = async (...args: string[]) => (await execute("docker", args)).stdout.trim();
    const networks: string[] = [];
    let sidecar: string | undefined;
    try {
      for (const project of [prefix + "sidecar", prefix + "network", "other_" + scope])
        networks.push(
          await run(
            "network",
            "create",
            "--label",
            `com.docker.compose.project=${project}`,
            project,
          ),
        );
      sidecar = await run(
        "run",
        "-d",
        "--label",
        `com.docker.compose.project=${prefix}sidecar`,
        "node:24.21.0-alpine",
        "sleep",
        "600",
      );
      expect(await pool.inventory(20)).toHaveLength(2);
      await pool.removeWorkspace(root);
      expect(await pool.inventory(20)).toEqual([]);
      await expect(run("inspect", sidecar)).rejects.toThrow();
      for (const id of networks.slice(0, 2))
        await expect(run("network", "inspect", id)).rejects.toThrow();
      expect(await run("network", "inspect", "--format", "{{.Name}}", networks[2]!)).toBe(
        "other_" + scope,
      );
    } finally {
      if (sidecar) await execute("docker", ["rm", "-f", sidecar]).catch(() => {});
      for (const id of networks) await execute("docker", ["network", "rm", id]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);
