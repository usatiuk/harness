import {
  commandEnvironment,
  parseShellExports,
  quoteShell,
  SHELL_STARTUP_TIMEOUT_MS,
  SHELL_EXPORT_MARKER,
} from "@harness/execution";
import { capture } from "./docker-cli.ts";
import type { Provisioned } from "./devcontainer.ts";

const environments = new WeakMap<Provisioned, Promise<NodeJS.ProcessEnv>>();

/**
 * The container owns shell selection and startup. No host HOME/PATH/SHELL is forwarded.
 * Docker's command dialect stays Bash; only the target user's exported environment is imported.
 * `timeout` owns the in-container startup process group even if the docker client disconnects.
 */
export function containerShellEnvironment(handle: Provisioned): Promise<NodeJS.ProcessEnv> {
  const existing = environments.get(handle);
  if (existing) return existing;
  const pending = discover(handle);
  environments.set(handle, pending); // A failed deterministic startup is not automatically retried.
  return pending;
}

const captureBody = `printf ${quoteShell(SHELL_EXPORT_MARKER.replaceAll("\0", "\\0"))}; exec /usr/bin/env -0`;
const captureExports = [
  'if [ -n "${BASH_VERSION-}" ] && [ -n "${BASH_ENV-}" ]; then',
  `  exec "$BASH" -c ${quoteShell(captureBody)} >&3`,
  "fi",
  `{ ${captureBody}; } >&3`,
].join("\n");

// This wrapper runs before the user's shell so startup chatter cannot enter the export channel.
export const CONTAINER_SHELL_PROBE = [
  "set -eu",
  'account=$(getent passwd "$(id -u)")',
  'HOME=$(printf "%s\\n" "$account" | cut -d: -f6)',
  'case "$HOME" in /*) ;; *) echo "Container target account has no absolute home directory" >&2; exit 64;; esac',
  "export HOME",
  'shell=${SHELL:-$(printf "%s\\n" "$account" | cut -d: -f7)}',
  'case "$shell" in /*/bash|/*/zsh) ;; *) echo "Unsupported container user shell; set SHELL to an absolute Bash or zsh path" >&2; exit 64;; esac',
  "exec 3>&1",
  "exec >/dev/null 2>/dev/null",
  `exec "$shell" -ilc ${quoteShell(captureExports)}`,
].join("\n");

async function discover(handle: Provisioned): Promise<NodeJS.ProcessEnv> {
  const result = await capture(
    "docker",
    [
      "exec",
      "-u",
      handle.remoteUser,
      handle.containerId,
      "timeout",
      "--signal=KILL",
      `${SHELL_STARTUP_TIMEOUT_MS / 1000}s`,
      "/bin/sh",
      "-c",
      CONTAINER_SHELL_PROBE,
    ],
    { signal: AbortSignal.timeout(SHELL_STARTUP_TIMEOUT_MS + 5000), maxBytes: 1024 * 1024 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Container shell initialization failed (exit ${result.exitCode}); requires a supported target shell, getent, GNU timeout, and /usr/bin/env`,
    );
  return commandEnvironment(parseShellExports(result.stdout));
}

/** NUL transport avoids putting environment values in docker argv or shell source text. */
export function encodeContainerEnvironment(env: NodeJS.ProcessEnv): Buffer {
  return Buffer.from(
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}\0`)
      .join(""),
  );
}

export const CONTAINER_COMMAND = [
  'while IFS= read -r -d "" entry; do export "$entry" || exit $?; done',
  "unset BASH_ENV ENV",
  'exec /bin/bash --norc -c "$1"',
].join("\n");
