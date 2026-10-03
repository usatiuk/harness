import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { captureText } from "./docker-cli.ts";

/** Default devcontainer config path (relative to the project root); the CLI auto-discovers it. */
export const DEFAULT_DEVCONTAINER_CONFIG = ".devcontainer/devcontainer.json";

/**
 * The root the sandbox keys, provisions, and tears down on: the nearest ancestor with a
 * `.devcontainer/` dir (the container's definition), else the path itself. The container is defined
 * by `.devcontainer/`, not the `.harness/` settings marker — decoupled so a project under the harness
 * home with `.devcontainer/` but no `.harness/` provisions against the project, not `~`. Keying on
 * this (not the raw cwd) means a CLI command or conversation started from a subdirectory resolves to
 * the same container, so containers can't leak or fork by working directory.
 */
export async function containerRoot(start: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    if (await isDirectory(join(dir, ".devcontainer"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locates the devcontainer CLI to run. Prefers the vendored `@devcontainers/cli` (so users need no
 * global install — only the Docker daemon), invoking its bin with the current `node`. Falls back to
 * a `devcontainer` on PATH if the bundled package can't be resolved.
 */
function devcontainerCmd(): { cmd: string; pre: string[] } {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@devcontainers/cli/package.json");
    const bin = join(dirname(pkgJson), "devcontainer.js"); // pkg.bin.devcontainer
    return { cmd: process.execPath, pre: [bin] };
  } catch {
    return { cmd: "devcontainer", pre: [] };
  }
}

/** The container handle resolved by `devcontainer up`, cached for fast `docker exec` per call. */
export interface Provisioned {
  containerId: string;
  /** The user `exec` runs as (devcontainer's `remoteUser`), so writes get the right ownership. */
  remoteUser: string;
  /** Where the workspace is mounted inside the container; tool-relative paths resolve against it. */
  remoteWorkspaceFolder: string;
}

export { isSandboxStatus, type SandboxPhase, type SandboxStatus } from "./events.ts";
import type { SandboxPhase, SandboxStatus } from "./events.ts";

/** Marks every container the harness creates, so the reaper can find them without our own bookkeeping. */
export const HARNESS_OWNER_LABEL = "harness.owner=harness";

/**
 * Stable per-workspace id-label so `devcontainer up` reattaches across harness restarts (keyed on
 * the workspace, not the pid, which would change each launch and defeat reuse).
 */
export function workspaceLabel(root: string): string {
  return `harness.workspace=${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/** Recipe identity also names the Compose project; id labels alone do not isolate Compose. */
export function environmentName(root: string, configPath: string): string {
  const canonical = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const identity = JSON.stringify([canonical(root), canonical(resolve(root, configPath))]);
  return `harness_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

export const environmentLabel = (root: string, configPath: string): string =>
  `harness.environment=${environmentName(root, configPath)}`;

export interface ProvisionOptions {
  /** Devcontainer config path relative to the workspace; only passed through when non-default. */
  configPath: string;
  /** The CLI process has started and may create owned resources. Never called on validation/spawn failure. */
  onStarted?: () => void;
  onStatus?: (status: SandboxStatus) => void;
  /**
   * Cancels an in-flight build: aborting kills the `devcontainer up` child (the promise then
   * rejects). The container `up` may already have created is still labelled, so the caller reaps it
   * by label after this settles — see `DockerExecutionContext.stop`.
   */
  signal?: AbortSignal;
}

/**
 * Ensures the workspace's dev container exists and is running, returning its handle. Drives the
 * reference `@devcontainers/cli` headless (`up --log-format json`): we do not build images
 * ourselves. Progress lines on stderr feed `onStatus`; the final result JSON on stdout carries the
 * container handle. Reuses an existing container by id-label, so this is cheap on warm starts.
 */
export async function provisionDevcontainer(
  hostRoot: string,
  opts: ProvisionOptions,
): Promise<Provisioned> {
  // Resolve to the `.devcontainer/` root so the container key (and the config lookup) is the same
  // whether invoked from the project root or a subdirectory.
  const root = await containerRoot(hostRoot);
  // Fail fast on a misconfiguration ("sandbox enabled, no devcontainer") with a clear message,
  // rather than letting the devcontainer CLI fail opaquely deep in `up`.
  if (!existsSync(resolve(root, opts.configPath))) {
    throw new Error(
      `sandbox enabled but no devcontainer config found at ${opts.configPath} (under ${root})`,
    );
  }
  const args = [
    "up",
    "--workspace-folder",
    root,
    "--id-label",
    workspaceLabel(root),
    "--id-label",
    HARNESS_OWNER_LABEL,
    "--id-label",
    environmentLabel(root, opts.configPath),
    "--log-format",
    "json",
  ];
  // The CLI auto-discovers the default config; only point it elsewhere when asked.
  if (opts.configPath && opts.configPath !== DEFAULT_DEVCONTAINER_CONFIG) {
    args.push("--config", resolve(root, opts.configPath));
  }

  const { cmd, pre } = devcontainerCmd();
  return new Promise<Provisioned>((resolvePromise, reject) => {
    const child = spawn(cmd, [...pre, ...args], {
      cwd: root,
      signal: opts.signal,
      env: { ...process.env, COMPOSE_PROJECT_NAME: environmentName(root, opts.configPath) },
    });
    child.once("spawn", () => opts.onStarted?.());
    let stdout = "";
    let stderr = "";
    let failure: NodeJS.ErrnoException | undefined;
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => {
      const chunk = b.toString("utf8");
      stderr += chunk;
      for (const line of chunk.split("\n")) emitProgress(line, opts.onStatus);
    });
    // Killing the CLI emits AbortError before close. Cleanup cannot run until the process stops
    // creating resources; settle both abort and spawn failures at the terminal close event.
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = error;
    });
    child.on("close", (code) => {
      // Intentional cancellation, not a build failure — reject quietly without an `error` phase.
      if (opts.signal?.aborted) {
        reject(new Error("devcontainer up aborted"));
        return;
      }
      if (failure) {
        reject(
          failure.code === "ENOENT"
            ? new Error(
                "devcontainer CLI not found (bundled @devcontainers/cli missing and none on PATH)",
              )
            : failure,
        );
        return;
      }
      if (code !== 0) {
        opts.onStatus?.({ type: "sandbox.status", phase: "error", message: tail(stderr) });
        reject(new Error(`devcontainer up failed (exit ${code}): ${tail(stderr)}`));
        return;
      }
      const result = parseResult(stdout);
      if (result instanceof Error) {
        reject(result);
        return;
      }
      opts.onStatus?.({ type: "sandbox.status", phase: "ready" });
      resolvePromise(result);
    });
  });
}

/** Maps a devcontainer JSONL log line to a coarse phase for the progress bar. Best-effort. */
function emitProgress(line: string, onStatus?: (s: SandboxStatus) => void): void {
  if (!onStatus) return;
  const text = parseLogText(line);
  if (!text) return;
  const phase: SandboxPhase = /build/i.test(text)
    ? "build"
    : /postCreate|onCreate|updateContent/i.test(text)
      ? "postCreate"
      : /creating|starting/i.test(text)
        ? "create"
        : "build";
  onStatus({ type: "sandbox.status", phase, message: text.slice(0, 200) });
}

/** Extracts `.text` from a devcontainer `--log-format json` line; ignores non-JSON/empty lines. */
function parseLogText(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const obj = JSON.parse(trimmed) as { text?: unknown };
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Finds the result object (the line carrying `outcome`) in `up`'s stdout. */
function parseResult(stdout: string): Provisioned | Error {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.includes("outcome")) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        outcome?: string;
        message?: string;
        description?: string;
        containerId?: string;
        remoteUser?: string;
        remoteWorkspaceFolder?: string;
      };
      if (obj.outcome === "error") {
        return new Error(`devcontainer up: ${obj.message ?? obj.description ?? "error"}`);
      }
      if (obj.outcome === "success" && obj.containerId && obj.remoteWorkspaceFolder) {
        return {
          containerId: obj.containerId,
          remoteUser: obj.remoteUser || "root",
          remoteWorkspaceFolder: obj.remoteWorkspaceFolder,
        };
      }
    } catch {
      // not the result line; keep scanning
    }
  }
  return new Error(`devcontainer up: could not parse result from output:\n${tail(stdout)}`);
}

function tail(s: string): string {
  return s.split("\n").filter(Boolean).slice(-8).join("\n");
}

/**
 * Tears down the workspace's container(s) by id-label (`rm -f`), returning how many were removed.
 * Reserved for explicit teardown (`stop()`/`rebuild()` and the standalone `harness sandbox stop`);
 * idle reaping uses `docker stop` instead.
 */
export async function stopSandbox(hostRoot: string, configPath?: string): Promise<number> {
  // Same `.devcontainer/` root key as `provisionDevcontainer`, so `stop` from a subdirectory targets
  // the container that was built — no leak, no spurious "no sandbox container running".
  const root = await containerRoot(hostRoot);
  const filters = [`label=${workspaceLabel(root)}`, `label=${HARNESS_OWNER_LABEL}`];
  if (configPath !== undefined) filters.push(`label=${environmentLabel(root, configPath)}`);
  const ids = new Set(
    await dockerIds("ps", ["-aq", ...filters.flatMap((filter) => ["--filter", filter])]),
  );
  if (configPath !== undefined) {
    const project = environmentName(root, configPath);
    // Compose sidecars do not receive devcontainer id labels. The explicitly assigned owned
    // project name covers them even when provisioning was aborted before returning a handle.
    for (const id of await dockerIds("ps", [
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]))
      ids.add(id);
    if (ids.size > 0) await checkedDocker(["rm", "-f", ...ids]);
    const networks = await dockerIds("network", [
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    if (networks.length > 0) await checkedDocker(["network", "rm", ...networks]);
  } else if (ids.size > 0) await checkedDocker(["rm", "-f", ...ids]);
  return ids.size;
}

async function checkedDocker(args: string[]): Promise<string> {
  const result = await captureText("docker", args);
  if (result.exitCode !== 0)
    throw new Error(
      `docker ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  return result.stdout;
}

async function dockerIds(command: string, args: string[]): Promise<string[]> {
  return (await checkedDocker([command, ...args])).split("\n").filter(Boolean);
}

/**
 * Removes stopped harness-owned containers older than `maxAgeHours`. Best-effort startup sweep.
 * Note: `docker container prune` only touches stopped containers, so a still-running container left
 * by a crashed harness is NOT reaped here — it is instead reused next time the workspace is opened
 * (warm reuse by id-label). Reaping running orphans needs a liveness signal (heartbeat); deferred.
 */
export async function reapStoppedSandboxes(maxAgeHours = 168): Promise<void> {
  await captureText("docker", [
    "container",
    "prune",
    "-f",
    "--filter",
    `label=${HARNESS_OWNER_LABEL}`,
    "--filter",
    `until=${maxAgeHours}h`,
  ]).catch(() => {
    // docker absent or daemon down — nothing to reap, and the sandbox is opt-in anyway
  });
}
