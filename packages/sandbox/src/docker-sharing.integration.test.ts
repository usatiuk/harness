import { unusedCodeEvaluator } from "@harness/testkit";
import { dockerTestEnvironment } from "./docker.test-support.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { SpawnedProcess } from "@harness/execution";
import { InMemoryStore } from "@harness/store";
import { HarnessService } from "@harness/service";
import { sandboxPlugin } from "./plugin.ts";
import { DockerExecutionContext } from "./docker.ts";
import { captureText } from "./docker-cli.ts";
import { environmentName, isSandboxStatus, removeSandbox } from "./devcontainer.ts";

const dockerIds = async (kind: "ps" | "network", project: string): Promise<string[]> => {
  const args = kind === "ps" ? ["ps", "-aq"] : ["network", "ls", "-q"];
  const result = await captureText("docker", [
    ...args,
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean);
};

async function command(execution: DockerExecutionContext, text: string): Promise<string> {
  const process = execution.spawn(text);
  let output = "";
  process.onData((chunk) => {
    output += chunk;
  });
  const result = await process.exit;
  if (result.code !== 0)
    throw new Error(`command failed (${result.code}/${result.signal}): ${output}`);
  return output;
}

function running(
  execution: DockerExecutionContext,
  label: string,
): { process: SpawnedProcess; started: Promise<void> } {
  const process = execution.spawn(`printf '${label}\\n'; sleep 600`);
  const started = new Promise<void>((resolvePromise, reject) => {
    let output = "";
    process.onData((chunk) => {
      output += chunk;
      if (output.includes(label)) resolvePromise();
    });
    void process.exit.then((result) =>
      reject(new Error(`command exited before readiness: ${JSON.stringify(result)} ${output}`)),
    );
  });
  return { process, started };
}

// Explicit qualification of the pinned devcontainer CLI and a real Linux Docker/Compose daemon.
// Ordinary unit runs do not download/build images or create environments.
describe.runIf(process.env.HARNESS_DOCKER_INTEGRATION === "1")(
  "shared devcontainer/Compose integration",
  () => {
    it("owns workspace, sidecar, and network lifetimes across independent conversation handles", async () => {
      const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (info.status !== 0 || info.stdout.trim() !== "linux")
        throw new Error(`Linux Docker daemon required: ${info.stderr || info.error?.message}`);
      const project = await mkdtemp(join(tmpdir(), "harness-shared-compose-"));
      const clientDirectory = await mkdtemp(join(tmpdir(), "harness-docker-client-"));
      for (const [key, value] of Object.entries(await dockerTestEnvironment(clientDirectory)))
        vi.stubEnv(key, value);
      const image = `harness-compose-fixture-${basename(project).toLowerCase()}`;
      const directory = join(project, ".devcontainer");
      const subdirectory = join(project, "subdir");
      const configPath = join(directory, "devcontainer.json"),
        alternatePath = join(directory, "alternate", "devcontainer.json");
      const firstProject = environmentName(project, configPath),
        alternateProject = environmentName(project, alternatePath);
      const service = new HarnessService({
        codeEvaluator: unusedCodeEvaluator,
        store: new InMemoryStore(),
        home: "/nonexistent-harness-home",
        defaults: {
          model: { provider: "fake", model: "fake" },
          plugins: { sandbox: { backend: "docker", docker: { idleTimeoutMinutes: 0 } } },
        },
        plugins: [sandboxPlugin],
      });
      const statuses: string[] = [];
      service.subscribe((event) => {
        if (isSandboxStatus(event) && event.message) statuses.push(event.message);
      });
      const roots: Array<Awaited<ReturnType<typeof service.createConversation>>> = [];
      const attach = async (cwd = project, overrides = {}) => {
        const conversation = await service.createConversation({ cwd, overrides });
        roots.push(conversation);
        await service.prepare(conversation.id);
        return {
          id: conversation.id,
          execution: service.service(conversation.id, "execution") as DockerExecutionContext,
        };
      };
      try {
        await Promise.all([mkdir(directory), mkdir(subdirectory)]);
        await mkdir(join(directory, "alternate"));
        await writeFile(
          join(directory, "Dockerfile"),
          "FROM debian:stable-slim\nRUN apt-get update -qq && apt-get install -y -qq procps && rm -rf /var/lib/apt/lists/*\n",
        );
        const built = await captureText("docker", ["build", "-t", image, directory]);
        if (built.exitCode !== 0) throw new Error(`Fixture image build failed: ${built.stderr}`);
        await writeFile(
          join(directory, "compose.yaml"),
          `services:\n  workspace:\n    image: ${image}\n    command: sleep infinity\n    volumes:\n      - ../:/workspaces/project\n  sidecar:\n    image: debian:stable-slim\n    command: sleep infinity\n`,
        );
        const config = {
          name: "Harness ownership integration",
          dockerComposeFile: "compose.yaml",
          service: "workspace",
          runServices: ["workspace", "sidecar"],
          workspaceFolder: "/workspaces/project",
          remoteUser: "root",
          overrideCommand: false,
          shutdownAction: "none",
        };
        await Promise.all([
          writeFile(configPath, JSON.stringify(config)),
          writeFile(
            alternatePath,
            JSON.stringify({ ...config, dockerComposeFile: "../compose.yaml" }),
          ),
        ]);
        const a = await attach(),
          b = await attach(),
          c = await attach(subdirectory);
        const warnings: string[] = [];
        service.subscribe((event) => {
          if (isSandboxStatus(event) && event.phase === "warning")
            warnings.push(String(event.message));
        });
        await b.execution.write("shared.txt", new TextEncoder().encode("persistent workspace"));
        expect(new TextDecoder().decode(await c.execution.read("../shared.txt"))).toBe(
          "persistent workspace",
        );
        expect((await command(c.execution, "pwd")).trim()).toBe("/workspaces/project/subdir");
        expect(await dockerIds("ps", firstProject)).toHaveLength(2);
        const background = running(b.execution, "B_READY");
        await background.started;
        let bExited = false;
        void background.process.exit.then(() => {
          bExited = true;
        });
        await service.deactivateSession(a.id);
        expect(bExited).toBe(false);
        expect(await dockerIds("ps", firstProject)).toHaveLength(2);
        const e = await attach();
        const ownCommand = running(e.execution, "E_READY");
        await ownCommand.started;
        await service.deactivateSession(e.id);
        await ownCommand.process.exit;
        expect(bExited).toBe(false);
        expect((await command(c.execution, "printf usable")).trim()).toBe("usable");
        const alternate = await attach(project, {
          plugins: {
            sandbox: { docker: { configPath: ".devcontainer/alternate/devcontainer.json" } },
          },
        });
        await alternate.execution.read("shared.txt");
        expect(await dockerIds("ps", alternateProject)).toHaveLength(2);
        await b.execution.rebuild();
        await background.process.exit;
        expect(bExited).toBe(true);
        expect(warnings).toHaveLength(2);
        expect(warnings.every((warning) => warning.includes("2 conversations"))).toBe(true);
        expect(c.execution.isProvisioned()).toBe(true);
        expect(new TextDecoder().decode(await c.execution.read("../shared.txt"))).toBe(
          "persistent workspace",
        );
        await service.deactivateSession(b.id);
        expect(await dockerIds("ps", firstProject)).toHaveLength(2);
        await command(c.execution, "printf retained > /tmp/harness-retained-state");
        await c.execution.stop();
        expect(await dockerIds("ps", firstProject)).toHaveLength(2);
        const states = await captureText("docker", [
          "inspect",
          "--format",
          "{{.State.Running}}",
          ...(await dockerIds("ps", firstProject)),
        ]);
        expect(states.stdout.trim().split("\n")).toEqual(["false", "false"]);
        await service.prepare(c.id);
        expect((await command(c.execution, "cat /tmp/harness-retained-state")).trim()).toBe(
          "retained",
        );
        await service.deactivateSession(c.id);
        expect(await dockerIds("ps", firstProject)).toHaveLength(2);
        expect((await dockerIds("network", firstProject)).length).toBeGreaterThan(0);
        expect(await dockerIds("ps", alternateProject)).toHaveLength(2);
        await service.deactivateSession(alternate.id);
        expect(await dockerIds("ps", alternateProject)).toHaveLength(2);
        expect((await dockerIds("network", alternateProject)).length).toBeGreaterThan(0);
      } catch (error) {
        throw new Error(`${String(error)}\nFixture provisioning status:\n${statuses.join("\n")}`, {
          cause: error,
        });
      } finally {
        await Promise.allSettled(
          roots.map((root) => service.deactivateSession(root.id, { force: true })),
        );
        await Promise.all([
          removeSandbox(project, configPath),
          removeSandbox(project, alternatePath),
        ]);
        await captureText("docker", ["image", "rm", image]);
        await rm(project, { recursive: true, force: true });
        await rm(clientDirectory, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 240_000);
  },
);
