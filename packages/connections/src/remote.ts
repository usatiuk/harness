import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { defaultHome } from "@harness/config";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { verifyRelease } from "@harness/native";
import {
  BUILD_IDENTITY,
  NODE_PIN,
  RELEASE_REPOSITORY,
  artifactSchema,
  developmentRemoteSchema,
  releaseManifestSchema,
  versionSchema,
  type ReleaseArtifact,
} from "@harness/release";
import { preparedServerSchema } from "./local-runtime.ts";
import { canonicalHome } from "./local.ts";
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
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      output += chunk.toString();
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
const TARGET = "linux-x64-glibc";
const preparedTransferSchema = preparedServerSchema.extend({ home: z.string().startsWith("/") });
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

async function downloadArtifact(
  artifact: ReleaseArtifact,
  destination: string,
  options: RemoteOptions,
): Promise<void> {
  const deadline = AbortSignal.timeout(180_000);
  const response = await fetch(artifact.url, {
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
  if (!response.ok || !response.body)
    throw new Error(`Artifact download failed: HTTP ${response.status}`);
  const output = await open(destination, "wx", 0o600);
  let size = 0;
  const hash = createHash("sha256");
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > artifact.size) throw new Error("Artifact exceeds its declared size");
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    if (size !== artifact.size || hash.digest("hex") !== artifact.sha256)
      throw new Error("Artifact size or checksum mismatch");
  } finally {
    await output.close();
  }
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
      `set -eu; command -v sha256sum >/dev/null; printf '%s\n' "$HOME"; uname -sm; getconf GNU_LIBC_VERSION`,
      options,
    )
  ).split("\n");
  if (!userHome?.startsWith("/") || machine !== "Linux x86_64" || !libc?.startsWith("glibc "))
    throw new Error("Remote servers currently support Linux x64 with glibc");
  const home = z
    .string()
    .startsWith("/")
    .parse(
      await runRemote(
        host,
        `set -eu; umask 077; ${privateDirectory(`${userHome}/.harness`)} readlink -f ${q(`${userHome}/.harness`)}`,
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
  const suffix = `-${TARGET}`;
  let releaseVersion: string | undefined;
  if (selected && !selected.directory.startsWith(`dev-${TARGET}-`)) {
    if (!selected.directory.endsWith(suffix))
      throw new Error("Selected server is not for the remote platform");
    releaseVersion = versionSchema.parse(selected.directory.slice(0, -suffix.length));
  } else if (BUILD_IDENTITY.mode === "release") {
    if (selected)
      throw new Error("Selected remote server is a source build; use its development checkout");
    releaseVersion = BUILD_IDENTITY.productVersion;
  }
  const localStaging = join(await canonicalHome(defaultHome()), "staging");
  await mkdir(localStaging, { recursive: true, mode: 0o700 });
  const localStage = await mkdtemp(join(localStaging, "remote-"));
  const stage = `${home}/staging/remote-${randomUUID()}`;
  const cleanup = { ...options };
  delete cleanup.signal;
  let staged = false;
  return cleanupAfter(
    (async () => {
      let directory: string;
      let buildId: string;
      let nodeArtifact: ReleaseArtifact;
      let serverArtifact: { size: number; sha256: string };
      let bootstrapArtifact: { size: number; sha256: string };
      let sourceDirectory: string | undefined;
      let manifest: Buffer | undefined;
      let signature: Buffer | undefined;
      let releaseServer: ReleaseArtifact | undefined;
      let releaseBootstrap: ReleaseArtifact | undefined;
      if (releaseVersion) {
        options.progress?.(`Verifying server ${releaseVersion}`);
        const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${releaseVersion}/release.json`;
        // Read original bytes in base64: runRemote trims display output, which
        // must never change the bytes covered by a release signature.
        const saved = await runRemote(
          host,
          `set -eu; if test -e ${q(`${home}/server/${releaseVersion}-${TARGET}`)}; then base64 -w0 ${q(`${home}/server/${releaseVersion}-${TARGET}/release.json`)}; printf '\\n'; base64 -w0 ${q(`${home}/server/${releaseVersion}-${TARGET}/release.json.minisig`)}; else printf null; fi`,
          options,
        );
        if (saved === "null") {
          [manifest, signature] = await Promise.all([
            fetchBytes(url, 1024 * 1024, options),
            fetchBytes(`${url}.minisig`, 16 * 1024, options),
          ]);
        } else {
          const encoded = z.tuple([z.string().min(1), z.string().min(1)]).parse(saved.split("\n"));
          manifest = Buffer.from(encoded[0], "base64");
          signature = Buffer.from(encoded[1], "base64");
        }
        const release = releaseManifestSchema.parse(
          JSON.parse(verifyRelease(manifest, signature.toString("utf8"))),
        );
        if (release.productVersion !== releaseVersion)
          throw new Error("Release differs from the captured server version");
        const target = release.targets[TARGET];
        if (!target || target.launcher.format !== "file")
          throw new Error("Release has no Linux bootstrap executable");
        nodeArtifact = target.node.artifact;
        releaseServer = target.server;
        releaseBootstrap = target.launcher;
        serverArtifact = releaseServer;
        bootstrapArtifact = releaseBootstrap;
        directory = `${releaseVersion}-${TARGET}`;
        buildId = serverArtifact.sha256;
      } else {
        sourceDirectory =
          options.env?.["HARNESS_DEVELOPMENT_REMOTE_PAYLOAD"] ??
          process.env["HARNESS_DEVELOPMENT_REMOTE_PAYLOAD"] ??
          payload;
        if (!sourceDirectory)
          throw new Error(
            "Build a Linux remote payload with npm run prepare:remote and set HARNESS_DEVELOPMENT_REMOTE_PAYLOAD to its output directory",
          );
        const source = developmentRemoteSchema.parse(
          JSON.parse(await readFile(join(sourceDirectory, "remote.json"), "utf8")),
        );
        if (source.nodeVersion !== NODE_PIN.version)
          throw new Error("Remote source payload requires a different pinned Node runtime");
        nodeArtifact = artifactSchema.parse(NODE_PIN.targets[TARGET]);
        serverArtifact = source.server;
        bootstrapArtifact = source.bootstrap;
        directory = `dev-${TARGET}-${source.server.sha256}`;
        buildId = source.server.sha256;
      }
      const installed = `${home}/server/${directory}`;
      const warm = JSON.parse(
        await runRemotePreparation(
          host,
          `set -eu; if test -e ${q(installed)}; then exec env HARNESS_HOME=${q(home)} ${q(`${installed}/harness-bootstrap`)} --inspect-cached-server ${q(directory)}; else printf null; fi`,
          options,
        ),
      ) as unknown;
      const consume = (value: unknown, transferred: boolean): PreparedRuntime => {
        const prepared = preparedTransferSchema.parse(value);
        if (
          prepared.home !== home ||
          prepared.payload !== installed ||
          prepared.entry !== `${installed}/server.mjs` ||
          prepared.keys[1] !== `server-${directory}`
        )
          throw new Error("Prepared remote server differs from the captured installation");
        return { node: prepared.node, directory: prepared.payload, home, buildId, transferred };
      };
      if (warm !== null) return consume(warm, false);
      options.progress?.("Transferring complete server and pinned Node runtime");
      const nodeArchive = join(localStage, "node.archive");
      await downloadArtifact(nodeArtifact, nodeArchive, options);
      let serverArchive: string;
      let bootstrap: string;
      if (sourceDirectory) {
        serverArchive = join(sourceDirectory, "server.tar.gz");
        bootstrap = join(sourceDirectory, "harness-bootstrap");
      } else {
        if (!releaseServer || !releaseBootstrap || !manifest || !signature)
          throw new Error("Release preparation lost its captured artifacts");
        serverArchive = join(localStage, "server.archive");
        bootstrap = join(localStage, "harness-bootstrap");
        await Promise.all([
          downloadArtifact(releaseServer, serverArchive, options),
          downloadArtifact(releaseBootstrap, bootstrap, options),
        ]);
      }
      staged = true;
      await runRemote(
        host,
        `set -eu; umask 077; ${privateDirectory(`${home}/staging`)} mkdir ${q(stage)}`,
        options,
      );
      const transfer = async (
        path: string,
        name: string,
        artifact: { size: number; sha256: string },
      ): Promise<void> => {
        const destination = `${stage}/${name}`;
        await runRemote(
          host,
          `set -eu; umask 077; cat > ${q(destination)}; test "$(wc -c < ${q(destination)})" -eq ${artifact.size}; printf '%s\n' ${q(`${artifact.sha256}  ${destination}`)} | sha256sum -c - >&2`,
          options,
          createReadStream(path),
        );
      };
      await transfer(bootstrap, "harness-bootstrap", bootstrapArtifact);
      await transfer(nodeArchive, "node.archive", nodeArtifact);
      await transfer(serverArchive, "server.archive", serverArtifact);
      let request: Record<string, unknown>;
      if (releaseVersion) {
        if (!manifest || !signature)
          throw new Error("Release preparation lost its original signed bytes");
        await runRemote(
          host,
          `set -eu; umask 077; cat > ${q(`${stage}/release.json`)}`,
          options,
          manifest.toString("utf8"),
        );
        await runRemote(
          host,
          `set -eu; umask 077; cat > ${q(`${stage}/release.json.minisig`)}`,
          options,
          signature.toString("utf8"),
        );
        request = {
          kind: "release",
          version: releaseVersion,
          manifest: `${stage}/release.json`,
          signature: `${stage}/release.json.minisig`,
          serverArchive: `${stage}/server.archive`,
          nodeArchive: `${stage}/node.archive`,
        };
      } else {
        request = {
          kind: "development",
          archive: `${stage}/server.archive`,
          size: serverArtifact.size,
          sha256: serverArtifact.sha256,
          nodeArchive: `${stage}/node.archive`,
        };
      }
      const prepared = JSON.parse(
        await runRemotePreparation(
          host,
          `set -eu; chmod 700 ${q(`${stage}/harness-bootstrap`)}; exec env HARNESS_HOME=${q(home)} ${q(`${stage}/harness-bootstrap`)} --install-transferred-server ${q(JSON.stringify(request))}`,
          options,
        ),
      ) as unknown;
      return consume(prepared, true);
    })(),
    async () => {
      try {
        if (staged) await runRemote(host, `rm -rf ${q(stage)}`, cleanup);
      } finally {
        await rm(localStage, { recursive: true, force: true });
      }
    },
  );
}

function bridgeCommand(runtime: PreparedRuntime, allowStart: boolean): string {
  return `exec env HARNESS_HOME=${q(runtime.home)} ${q(`${runtime.directory}/harness-bootstrap`)} --run-cached-server ${q(posix.basename(runtime.directory))} ${allowStart ? "--bridge" : "--attach-only"}`;
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
