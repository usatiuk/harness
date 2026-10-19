import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { verifyRelease } from "@harness/native";
import {
  BUILD_IDENTITY,
  NODE_PIN,
  RELEASE_REPOSITORY,
  developmentRemoteSchema,
  releaseManifestSchema,
  versionSchema,
  compareVersions,
  type LinuxTarget,
} from "@harness/release";
import { preparedServerSchema } from "./local-runtime.ts";
import { serverSelectionSchema } from "./selection.ts";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { forwardBridgeInput } from "./bridge-input.ts";
import type { RpcConnection } from "@harness/client";
import { hostSchema, type RemoteHost, type PreparedRuntime } from "./contracts.ts";
export type { RemoteHost, PreparedRuntime } from "./contracts.ts";

async function cleanupAfter<T>(work: Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  const [result] = await Promise.allSettled([work]);
  try {
    await cleanup();
  } catch (error) {
    if (result.status === "rejected")
      throw new AggregateError([result.reason, error], "Provisioning and cleanup failed", {
        cause: error,
      });
    throw error;
  }
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export interface RemoteOptions {
  /** Process-edge override for isolated OpenSSH qualification, never a saved host setting. */
  sshConfigFile?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  progress?: (message: string) => void;
}
export class RemoteCommandError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** OpenSSH owns aliases, authentication and host-key verification; stdout remains protocol-only. */
export function remoteCommand(
  host: RemoteHost,
  script: string,
  sshConfigFile?: string,
): { executable: string; args: string[] } {
  hostSchema.parse(host);
  if (host.kind === "wsl") {
    if (process.platform !== "win32") throw new Error("WSL connections require a Windows client");
    return {
      executable: "wsl.exe",
      args: [
        "--distribution",
        host.distribution,
        ...(host.user === null ? [] : ["--user", host.user]),
        "--exec",
        "sh",
        "-c",
        script,
      ],
    };
  }
  return {
    executable: "ssh",
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      ...(sshConfigFile ? ["-F", sshConfigFile] : []),
      "--",
      host.destination,
      `sh -c ${shellQuote(script)}`,
    ],
  };
}
function remoteProcess(
  host: RemoteHost,
  script: string,
  options: RemoteOptions,
  timeout = 600_000,
): ChildProcessWithoutNullStreams {
  const command = remoteCommand(host, script, options.sshConfigFile);
  const child = spawn(command.executable, command.args, {
    env: { ...process.env, ...options.env },
    windowsHide: true,
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return child;
}
export async function runRemote(
  host: RemoteHost,
  script: string,
  options: RemoteOptions = {},
  input?: string | Readable,
): Promise<string> {
  return executeRemote(host, script, options, input);
}

/** Keep preparation stdin open until readiness; cancellation delivers EOF and
 * awaits target exit instead of killing only the local SSH/WSL transport. */
function runRemotePreparation(
  host: RemoteHost,
  script: string,
  options: RemoteOptions,
): Promise<string> {
  return executeRemote(host, script, options, undefined, true);
}

async function executeRemote(
  host: RemoteHost,
  script: string,
  options: RemoteOptions,
  input?: string | Readable,
  preparation = false,
): Promise<string> {
  const signal = preparation
    ? AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(600_000)])
    : options.signal;
  signal?.throwIfAborted();
  const processOptions = { ...options };
  if (preparation) delete processOptions.signal;
  const child = remoteProcess(host, script, processOptions, preparation ? 0 : 600_000);
  let output = "";
  let diagnostic = "";
  let failure: Error | undefined;
  const cancel = () => {
    failure ??=
      signal!.reason instanceof Error
        ? signal!.reason
        : new DOMException("Remote preparation cancelled", "AbortError");
    child.stdin.end();
  };
  if (preparation) {
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    signal!.addEventListener("abort", cancel, { once: true });
    if (signal!.aborted) cancel();
  }
  const result = new Promise<string>((resolve, reject) => {
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failure) return;
      output += chunk;
      if (preparation && output.includes("\n")) child.stdin.end();
      if (Buffer.byteLength(output) > 1024 * 1024) {
        failure = new Error("Remote command output exceeds 1 MiB");
        output = "";
        if (preparation) child.stdin.end();
        else child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    child.on("close", (code) =>
      failure
        ? reject(failure)
        : code === 0
          ? resolve(output.trim())
          : reject(
              new RemoteCommandError(
                code,
                diagnostic.trim() || `Remote command exited with ${String(code)}`,
              ),
            ),
    );
  });
  // Observe stdin errors for text, archive and empty uploads alike, and settle
  // only after transport close. A broken pipe is a provisioning failure.
  const sent = preparation
    ? Promise.resolve()
    : pipeline(
        typeof input === "string" ? Readable.from([input]) : (input ?? Readable.from([])),
        child.stdin,
      );
  const settled = await Promise.allSettled([result, sent]);
  if (preparation) signal!.removeEventListener("abort", cancel);
  const remote = settled[0];
  if (remote.status === "rejected") throw remote.reason;
  const transfer = settled[1];
  if (transfer.status === "rejected") throw transfer.reason;
  return remote.value;
}

export async function discoverWsl(signal?: AbortSignal): Promise<string[]> {
  if (process.platform !== "win32") return [];
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      "wsl.exe",
      ["--list", "--quiet"],
      {
        windowsHide: true,
        encoding: "utf16le",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") resolve([]);
          else reject(new Error(error.message, { cause: error }));
        } else
          resolve(
            stdout
              .split(/\r?\n/u)
              .map((entry) => entry.trim())
              .filter(Boolean),
          );
      },
    );
  });
}

const q = shellQuote;
const preparedTransferSchema = preparedServerSchema.extend({
  home: z.string().startsWith("/").optional(),
});
/** Every transfer belongs to the authenticated OS account, including its ancestry. */
const privateDirectory = (path: string): string =>
  `mkdir -p ${q(path)}; cursor=$(readlink -f ${q(path)}); leafMode=$(stat -c %a "$cursor"); test $((0$leafMode & 0022)) = 0 || { echo 'Runtime directory is writable by other users' >&2; exit 1; }; uid=$(id -u); while :; do owner=$(stat -c %u "$cursor"); mode=$(stat -c %a "$cursor"); test "$owner" = "$uid" || test "$owner" = 0 || { echo 'Runtime ancestry belongs to another user' >&2; exit 1; }; if test $((0$mode & 0022)) != 0 && test $((0$mode & 01000)) = 0; then echo 'Runtime ancestry is writable by other users' >&2; exit 1; fi; test "$cursor" = / && break; cursor=$(dirname "$cursor"); done; test "$(stat -c %u ${q(path)})" = "$uid" || { echo 'Runtime directory belongs to another user' >&2; exit 1; };`;

async function fetchBytes(url: string, limit: number, options: RemoteOptions): Promise<Buffer> {
  const deadline = AbortSignal.timeout(120_000);
  const response = await fetch(url, {
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
  if (!response.ok || !response.body)
    throw new Error(`Release download failed: HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) throw new Error("Release metadata exceeds its size limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function prepareRemoteRuntime(
  host: RemoteHost,
  payload: string,
  options: RemoteOptions = {},
): Promise<PreparedRuntime> {
  options.progress?.("Inspecting remote platform");
  const [userHome, machine, libc] = (
    await runRemote(
      host,
      `set -eu; printf '%s\n' "$HOME"; uname -sm; getconf GNU_LIBC_VERSION 2>/dev/null || printf 'unsupported-libc\n'`,
      options,
    )
  ).split("\n");
  const target: LinuxTarget | undefined =
    machine === "Linux x86_64"
      ? "linux-x64-glibc"
      : machine === "Linux aarch64" || machine === "Linux arm64"
        ? "linux-arm64-glibc"
        : undefined;
  if (!target || !libc?.startsWith("glibc "))
    throw new Error(
      `Unsupported remote platform (${machine ?? "unknown"}; ${libc ?? "unknown libc"}); remote servers require Linux x64 or ARM64 with glibc (musl is not supported)`,
    );
  if (!userHome?.startsWith("/")) throw new Error("Remote account HOME must be an absolute path");
  const home = z
    .string()
    .startsWith("/")
    .parse(
      await runRemote(
        host,
        `set -eu; command -v sha256sum >/dev/null || { echo 'Remote runtime preparation requires sha256sum' >&2; exit 1; }; umask 077; ${privateDirectory(`${userHome}/.harness`)} readlink -f ${q(`${userHome}/.harness`)}`,
        options,
      ),
    );
  const selected = serverSelectionSchema
    .nullable()
    .parse(
      JSON.parse(
        await runRemote(
          host,
          `set -eu; if test -f ${q(`${home}/server/current.json`)}; then cat ${q(`${home}/server/current.json`)}; else printf null; fi`,
          options,
        ),
      ),
    );
  const suffix = `-${target}`;
  let releaseVersion: string | undefined;
  if (selected && !selected.directory.startsWith(`dev-${target}-`)) {
    if (!selected.directory.endsWith(suffix))
      throw new Error("Selected server is not for the remote platform");
    releaseVersion = versionSchema.parse(selected.directory.slice(0, -suffix.length));
    if (
      BUILD_IDENTITY.mode === "release" &&
      compareVersions(BUILD_IDENTITY.productVersion, releaseVersion) > 0
    )
      releaseVersion = BUILD_IDENTITY.productVersion;
  } else if (BUILD_IDENTITY.mode === "release") {
    if (selected)
      throw new Error("Selected remote server is a source build; use its development checkout");
    releaseVersion = BUILD_IDENTITY.productVersion;
  }
  let sourceDirectory: string | undefined;
  let buildId: string;
  let bootstrap: { size: number; sha256: string } & ({ path: string } | { url: string });
  let server: { size: number; sha256: string } | undefined;
  if (releaseVersion) {
    const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${releaseVersion}/release.json`;
    const installed = `${home}/server/${releaseVersion}-${target}`;
    // Preserve original signed bytes when reading through the display-oriented command helper.
    const saved = await runRemote(
      host,
      `set -eu; if test -e ${q(installed)}; then base64 -w0 ${q(`${installed}/release.json`)}; printf '\n'; base64 -w0 ${q(`${installed}/release.json.minisig`)}; else printf null; fi`,
      options,
    );
    const [manifest, signature] =
      saved === "null"
        ? await Promise.all([
            fetchBytes(url, 1024 * 1024, options),
            fetchBytes(`${url}.minisig`, 16 * 1024, options),
          ])
        : z
            .tuple([z.string().min(1), z.string().min(1)])
            .parse(saved.split("\n"))
            .map((value) => Buffer.from(value, "base64"));
    const release = releaseManifestSchema.parse(
      JSON.parse(verifyRelease(manifest, signature.toString("utf8"))),
    );
    if (release.productVersion !== releaseVersion)
      throw new Error("Release differs from the selected server version");
    const artifacts = release.targets[target];
    if (!artifacts || artifacts.launcher.format !== "file")
      throw new Error(`Release has no bootstrap executable for ${target}`);
    buildId = artifacts.server.sha256;
    bootstrap = { ...artifacts.launcher };
  } else {
    sourceDirectory =
      options.env?.["HARNESS_DEVELOPMENT_REMOTE_PAYLOAD"] ??
      process.env["HARNESS_DEVELOPMENT_REMOTE_PAYLOAD"] ??
      payload;
    const source = developmentRemoteSchema.parse(
      JSON.parse(await readFile(join(sourceDirectory, "remote.json"), "utf8")),
    );
    if (source.target !== target)
      throw new Error(
        `Development remote payload targets ${source.target}, but the remote platform is ${target}; build the payload on a matching Linux host with npm run prepare:remote and select it with HARNESS_DEVELOPMENT_REMOTE_PAYLOAD`,
      );
    if (source.nodeVersion !== NODE_PIN.version)
      throw new Error("Remote source payload requires a different pinned Node runtime");
    server = source.server;
    buildId = source.server.sha256;
    bootstrap = { ...source.bootstrap, path: join(sourceDirectory, "harness-bootstrap") };
  }
  const directory = releaseVersion ? `${releaseVersion}-${target}` : `dev-${target}-${buildId}`;
  const installed = `${home}/server/${directory}`;
  const consume = (value: unknown, transferred: boolean): PreparedRuntime => {
    const prepared = preparedTransferSchema.parse(value);
    if (
      (prepared.home !== undefined && prepared.home !== home) ||
      prepared.payload !== installed ||
      prepared.entry !== `${installed}/server.mjs`
    )
      throw new Error("Prepared remote server differs from the selected installation");
    return { node: prepared.node, directory: installed, home, buildId, transferred };
  };
  const warm = JSON.parse(
    await runRemotePreparation(
      host,
      `set -eu; if test -e ${q(installed)}; then exec env HARNESS_HOME=${q(home)} ${q(`${installed}/harness-bootstrap`)} --inspect-cached-server ${q(directory)} --remote; else printf null; fi`,
      options,
    ),
  ) as unknown;
  if (warm !== null) return consume(warm, false);
  options.progress?.(
    sourceDirectory
      ? "Transferring development server"
      : "Installing remote bootstrap; target downloads server and Node",
  );
  const stage = `${home}/staging/remote-${randomUUID()}`;
  const cleanup = { ...options };
  delete cleanup.signal;
  return cleanupAfter(
    (async () => {
      await runRemote(
        host,
        `set -eu; umask 077; ${privateDirectory(`${home}/staging`)} mkdir ${q(stage)}`,
        options,
      );
      const transfer = async (
        name: string,
        input: Readable,
        artifact: { size: number; sha256: string },
      ) => {
        const destination = `${stage}/${name}`;
        await runRemote(
          host,
          `set -eu; umask 077; cat > ${q(destination)}; test "$(wc -c < ${q(destination)})" -eq ${artifact.size}; printf '%s\n' ${q(`${artifact.sha256}  ${destination}`)} | sha256sum -c - >&2`,
          options,
          input,
        );
      };
      if ("url" in bootstrap && bootstrap.size > 64 * 1024 * 1024)
        throw new Error("Remote bootstrap exceeds 64 MiB");
      const bootstrapInput =
        "path" in bootstrap
          ? createReadStream(bootstrap.path)
          : Readable.from([await fetchBytes(bootstrap.url, bootstrap.size, options)]);
      await transfer("harness-bootstrap", bootstrapInput, bootstrap);
      if (sourceDirectory && server)
        await transfer(
          "server.tar.gz",
          createReadStream(join(sourceDirectory, "server.tar.gz")),
          server,
        );
      const args = sourceDirectory
        ? `--install-development-server ${q(`${stage}/server.tar.gz`)} ${q(buildId)}`
        : `--prepare-release ${q(releaseVersion!)}`;
      const prepared = JSON.parse(
        await runRemotePreparation(
          host,
          `set -eu; chmod 700 ${q(`${stage}/harness-bootstrap`)}; exec env HARNESS_HOME=${q(home)} ${q(`${stage}/harness-bootstrap`)} ${args} --remote`,
          options,
        ),
      ) as unknown;
      return consume(prepared, true);
    })(),
    () => runRemote(host, `rm -rf ${q(stage)}`, cleanup).then(() => undefined),
  );
}
function bridgeCommand(runtime: PreparedRuntime, allowStart: boolean): string {
  const directory = posix.basename(runtime.directory);
  const command = `--run-cached-server ${q(directory)}`;
  return `exec env HARNESS_HOME=${q(runtime.home)} ${q(`${runtime.directory}/harness-bootstrap`)} ${command} ${allowStart ? "--bridge" : "--attach-only"}`;
}
export interface RemoteConnection {
  connection: RpcConnection;
  readonly failure: Error | undefined;
  close(): Promise<void>;
}
export async function connectRemote(
  host: RemoteHost,
  runtime: PreparedRuntime,
  options: RemoteOptions = {},
  allowStart = true,
): Promise<RemoteConnection> {
  const child = remoteProcess(host, bridgeCommand(runtime, allowStart), options, 0);
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8192);
  });
  let ended = false;
  let failure: Error | undefined;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      ended = true;
      if (code === 0 && !failure) resolve();
      else {
        failure ??= new RemoteCommandError(code, diagnostic || "Remote bridge disconnected");
        reject(failure);
      }
    });
  });
  // The client observes transport failure; retain the classified diagnostic for explicit close.
  void exited.catch(() => undefined);
  const connection = createNdjsonMessageConnection(child.stdout, child.stdin);
  let connectionClosed = false;
  connection.onClose(() => {
    connectionClosed = true;
  });
  return {
    connection,
    get failure() {
      return failure;
    },
    close: async () => {
      const alreadyEnded = ended || connectionClosed;
      connection.dispose();
      child.stdin.destroy();
      // Discard unacknowledged delivery and terminate only our transport process.
      // The independently launched owner retains every accepted operation.
      if (!ended) child.kill();
      await (alreadyEnded || child.killed ? exited.catch(() => undefined) : exited);
    },
  };
}

/** A native bridge relays bytes without acquiring ownership of remote execution. */
export async function runRemoteBridge(
  host: RemoteHost,
  runtime: PreparedRuntime,
  options: RemoteOptions = {},
): Promise<void> {
  const child = remoteProcess(host, bridgeCommand(runtime, true), options, 0);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let disposeInput!: () => void;
  let detaching = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        child.kill();
        reject(error);
      };
      child.once("error", failed);
      child.stdin.once("error", failed);
      disposeInput = forwardBridgeInput(
        child.stdin,
        () => {
          detaching = true;
          child.stdin.destroy();
          child.kill();
        },
        failed,
      );
      child.once("close", (code) =>
        code === 0 || detaching
          ? resolve()
          : reject(new RemoteCommandError(code, "Remote bridge disconnected")),
      );
    });
  } finally {
    disposeInput();
    child.stdout.unpipe(process.stdout);
    child.stderr.unpipe(process.stderr);
    if (child.exitCode === null) child.kill();
    await closed;
  }
}
