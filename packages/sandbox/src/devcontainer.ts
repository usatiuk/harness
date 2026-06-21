import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { captureText } from "./docker-cli.ts";

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

export type SandboxPhase = "build" | "create" | "postCreate" | "ready" | "error";

/**
 * Build/start progress, emitted onto the conversation stream so a client can render a bar. The
 * open index signature makes it a structural `PluginEvent` (the kernel stamps `conversationId`).
 */
export interface SandboxStatus {
  type: "sandbox.status";
  phase: SandboxPhase;
  message?: string;
  [key: string]: unknown;
}

/** Narrows a stream event to a sandbox status update (mirror of activities' `isActivityEvent`). */
export function isSandboxStatus(event: { type: string }): event is SandboxStatus {
  return event.type === "sandbox.status";
}

/** Marks every container the harness creates, so the reaper can find them without our own bookkeeping. */
export const HARNESS_OWNER_LABEL = "harness.owner=harness";

/**
 * Stable per-workspace id-label so `devcontainer up` reattaches across harness restarts (keyed on
 * the workspace, not the pid, which would change each launch and defeat reuse).
 */
export function workspaceLabel(root: string): string {
  return `harness.workspace=${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

export interface ProvisionOptions {
  /** Devcontainer config path relative to the workspace; only passed through when non-default. */
  configPath: string;
  onStatus?: (status: SandboxStatus) => void;
}

/**
 * Ensures the workspace's dev container exists and is running, returning its handle. Drives the
 * reference `@devcontainers/cli` headless (`up --log-format json`): we do not build images
 * ourselves. Progress lines on stderr feed `onStatus`; the final result JSON on stdout carries the
 * container handle. Reuses an existing container by id-label, so this is cheap on warm starts.
 */
export function provisionDevcontainer(
  hostRoot: string,
  opts: ProvisionOptions,
): Promise<Provisioned> {
  const args = [
    "up",
    "--workspace-folder",
    hostRoot,
    "--id-label",
    workspaceLabel(hostRoot),
    "--id-label",
    HARNESS_OWNER_LABEL,
    "--log-format",
    "json",
  ];
  // The CLI auto-discovers `.devcontainer/devcontainer.json`; only point it elsewhere when asked.
  if (opts.configPath && opts.configPath !== ".devcontainer/devcontainer.json") {
    args.push("--config", join(hostRoot, opts.configPath));
  }

  const { cmd, pre } = devcontainerCmd();
  return new Promise<Provisioned>((resolvePromise, reject) => {
    const child = spawn(cmd, [...pre, ...args], { cwd: hostRoot });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => {
      const chunk = b.toString("utf8");
      stderr += chunk;
      for (const line of chunk.split("\n")) emitProgress(line, opts.onStatus);
    });
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "ENOENT"
          ? new Error("devcontainer CLI not found (bundled @devcontainers/cli missing and none on PATH)") // prettier-ignore
          : e,
      ),
    );
    child.on("close", (code) => {
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
 * Tears down the workspace's container(s) by id-label, returning how many were removed. Shared by
 * the live `DockerExecutionContext.stop()` and the standalone `harness sandbox stop` command.
 */
export async function stopSandbox(hostRoot: string): Promise<number> {
  const ls = await captureText("docker", ["ps", "-aq", "--filter", `label=${workspaceLabel(hostRoot)}`]); // prettier-ignore
  const ids = ls.stdout.split("\n").filter(Boolean);
  if (ids.length > 0) await captureText("docker", ["rm", "-f", ...ids]);
  return ids.length;
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
