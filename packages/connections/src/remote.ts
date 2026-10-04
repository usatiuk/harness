import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, mkdir, open, rename, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { z } from "zod";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { forwardBridgeInput } from "./bridge-input.ts";
import type { RpcConnection } from "@harness/client";
import { hostSchema, type Host } from "./contracts.ts";

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

export type RemoteHost = Exclude<Host, { kind: "local" }>;
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
  const child = remoteProcess(host, script, options);
  let output = "";
  let diagnostic = "";
  const result = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 1024 * 1024) {
        child.kill();
        reject(new Error("Remote command output exceeds 1 MiB"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new RemoteCommandError(
              code,
              diagnostic.trim() || `Remote command exited with ${String(code)}`,
            ),
          ),
    );
  });
  if (typeof input === "string") child.stdin.end(input);
  else if (input) {
    // Observe both promises immediately: a remote failure can close stdin mid-transfer.
    const sent = pipeline(input, child.stdin);
    const settled = await Promise.allSettled([result, sent]);
    const remote = settled[0];
    if (remote.status === "rejected") throw remote.reason;
    const transfer = settled[1];
    if (transfer.status === "rejected") throw transfer.reason;
    return remote.value;
  } else child.stdin.end();
  return result;
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

const probeSchema = z.strictObject({
  home: z.string().startsWith("/"),
  base: z.string().startsWith("/"),
  machine: z.string(),
  libc: z.string(),
});
const q = shellQuote;
const files = ["server.mjs", "worker.mjs", "package.json", "package-lock.json"] as const;
const NODE_VERSION = "22.23.3";
const NODE_ARCHIVE = `node-v${NODE_VERSION}-linux-x64.tar.gz`;
const NODE_SHA256 = "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af";
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;

/** Every mutable installation directory is private to the executing OS user. */
const privateDirectory = (path: string): string =>
  `mkdir -p ${q(path)}; cursor=$(readlink -f ${q(path)}); leafMode=$(stat -c %a "$cursor"); test $((0$leafMode & 0022)) = 0 || { echo 'Runtime directory is writable by other users' >&2; exit 1; }; uid=$(id -u); while :; do owner=$(stat -c %u "$cursor"); mode=$(stat -c %a "$cursor"); test "$owner" = "$uid" || test "$owner" = 0 || { echo 'Runtime ancestry belongs to another user' >&2; exit 1; }; if test $((0$mode & 0022)) != 0 && test $((0$mode & 01000)) = 0; then echo 'Runtime ancestry is writable by other users' >&2; exit 1; fi; test "$cursor" = / && break; cursor=$(dirname "$cursor"); done; test "$(stat -c %u ${q(path)})" = "$uid" || { echo 'Runtime directory belongs to another user' >&2; exit 1; };`;

export interface PreparedRuntime {
  node: string;
  directory: string;
  home: string;
  buildId: string;
  dependencyKey: string;
  transferred: boolean;
}

async function cachedNodeArchive(signal?: AbortSignal): Promise<string> {
  const cache = join(
    process.env["HARNESS_CLIENT_HOME"] ?? join(homedir(), ".harness"),
    "downloads",
  );
  await mkdir(cache, { recursive: true });
  const path = join(cache, NODE_ARCHIVE);
  const valid = async () =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") === NODE_SHA256;
  try {
    if (await valid()) return path;
    throw new Error("Cached Node archive checksum mismatch");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const deadline = AbortSignal.timeout(120_000);
  const response = await fetch(NODE_URL, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok || !response.body)
    throw new Error(`Node download failed: HTTP ${response.status}`);
  const temporary = `${path}.${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for await (const value of response.body) {
      const bytes = Buffer.from(value);
      hash.update(bytes);
      await handle.write(bytes);
    }
    await handle.close();
    if (hash.digest("hex") !== NODE_SHA256)
      throw new Error("Downloaded Node archive checksum mismatch");
    await rename(temporary, path);
    return path;
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

export async function prepareRemoteRuntime(
  host: RemoteHost,
  payload: string,
  options: RemoteOptions = {},
): Promise<PreparedRuntime> {
  options.progress?.("Inspecting remote platform");
  const probe = probeSchema.parse(
    JSON.parse(
      await runRemote(
        host,
        `set -eu; command -v flock >/dev/null; command -v sha256sum >/dev/null; command -v tar >/dev/null; printf '%s\\n' "$HOME"; uname -sm; getconf GNU_LIBC_VERSION`,
        options,
      ).then((output) => {
        const [userHome, machine, libc] = output.split("\n");
        return JSON.stringify({
          home: host.home ?? `${userHome}/.harness`,
          base: host.runtime.directory ?? `${userHome}/.harness/runtimes`,
          machine,
          libc,
        });
      }),
    ),
  );
  if (probe.machine !== "Linux x86_64" || !probe.libc.startsWith("glibc "))
    throw new Error("Remote runtimes currently support Linux x64 with glibc");
  const base = await runRemote(
    host,
    `set -eu; umask 077; ${privateDirectory(probe.base)} readlink -f ${q(probe.base)}`,
    options,
  );
  const prefix = `set -eu; umask 077; ${privateDirectory(base)}`;
  await runRemote(host, prefix, options);
  const contents = await Promise.all(files.map((file) => readFile(join(payload, file))));
  const digests = contents.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  const buildId = createHash("sha256").update(digests.join("\n")).digest("hex");
  let node = host.runtime.node ?? "node";
  if (host.runtime.source === "managed") {
    node = `${base}/node-v${NODE_VERSION}/bin/node`;
    const archivePath = `${base}/node-download-${randomUUID()}.tar.gz`;
    const install = `${prefix} flock -w 120 ${q(`${base}/provision.lock`)} sh -c ${q(`set -eu; umask 077; if test ! -x ${q(node)}; then stage=${q(`${base}/node-stage-${randomUUID()}`)}; mkdir "$stage"; trap 'rm -rf "$stage"' EXIT; tar -xzf ${q(`${archivePath}`)} -C "$stage" --strip-components=1; mv "$stage" ${q(dirname(dirname(node)))}; fi`)}`;
    if (
      (await runRemote(host, `test -x ${q(node)} && printf ready || true`, options)) !== "ready"
    ) {
      options.progress?.("Obtaining verified portable Node runtime");
      const cleanup = { ...options };
      delete cleanup.signal;
      await cleanupAfter(
        (async () => {
          try {
            await runRemote(
              host,
              `${prefix} command -v curl >/dev/null || exit 77; curl --fail --location --connect-timeout 15 --max-time 120 ${q(NODE_URL)} -o ${q(`${archivePath}.partial`)} || exit 77; echo ${q(`${NODE_SHA256}  ${archivePath}.partial`)} | sha256sum -c - >&2 || exit 78; mv ${q(`${archivePath}.partial`)} ${q(archivePath)}`,
              options,
            );
          } catch (error) {
            if (!(error instanceof RemoteCommandError) || error.code !== 77) throw error;
            const archive = await cachedNodeArchive(options.signal);
            await runRemote(
              host,
              `${prefix} cat > ${q(`${archivePath}.partial`)}; echo ${q(`${NODE_SHA256}  ${archivePath}.partial`)} | sha256sum -c - >&2; mv ${q(`${archivePath}.partial`)} ${q(archivePath)}`,
              options,
              createReadStream(archive),
            );
          }
          await runRemote(host, install, options);
        })(),
        async () => {
          await runRemote(
            host,
            `${prefix} rm -f ${q(archivePath)} ${q(`${archivePath}.partial`)}`,
            cleanup,
          );
        },
      );
    }
  }
  const nodeInfo = z
    .strictObject({
      version: z.string(),
      modules: z.string(),
      platform: z.literal("linux"),
      arch: z.literal("x64"),
    })
    .parse(
      JSON.parse(
        await runRemote(
          host,
          `${q(node)} -p ${q("JSON.stringify({version:process.versions.node,modules:process.versions.modules,platform:process.platform,arch:process.arch})")}`,
          options,
        ),
      ),
    );
  if (Number(nodeInfo.version.split(".")[0]) < 22)
    throw new Error("Remote Node must be version 22 or newer");
  // Resolve PATH-based executables once; launch metadata never depends on a later SSH shell PATH.
  node = await runRemote(host, `readlink -f "$(command -v ${q(node)})"`, options);
  const npm = await runRemote(
    host,
    `if test -x ${q(`${dirname(node)}/npm`)}; then printf '%s' ${q(`${dirname(node)}/npm`)}; else readlink -f "$(command -v npm)"; fi`,
    options,
  );
  const dependencyKey = createHash("sha256")
    .update(`${digests[3]}:${nodeInfo.platform}:${nodeInfo.arch}:${nodeInfo.modules}`)
    .digest("hex");
  const directory = `${base}/builds/${buildId}-${dependencyKey}`;
  const existing = await runRemote(
    host,
    `test -f ${q(`${directory}/ready`)} && printf ready || true`,
    options,
  );
  if (existing === "ready")
    return { node, directory, home: probe.home, buildId, dependencyKey, transferred: false };
  options.progress?.("Transferring built server bundle");
  const stage = `${base}/stage-${randomUUID()}`;
  await runRemote(host, `${prefix} mkdir ${q(stage)}`, options);
  const archive = spawn("tar", ["-czf", "-", "-C", payload, ...files], { windowsHide: true });
  let archiveError = "";
  archive.stderr.on("data", (chunk: Buffer) => {
    archiveError = (archiveError + chunk.toString()).slice(-8192);
  });
  const archived = new Promise<void>((resolve, reject) => {
    archive.once("error", reject);
    archive.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(archiveError || "Could not archive server payload")),
    );
  });
  return cleanupAfter(
    (async () => {
      const transfer = runRemote(
        host,
        `${prefix} tar -xzf - -C ${q(stage)}`,
        options,
        archive.stdout,
      );
      const results = await Promise.allSettled([transfer, archived]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      const checks = files.map((file, index) => `${digests[index]}  ${stage}/${file}`).join("\n");
      await runRemote(host, `${prefix} printf '%s\\n' ${q(checks)} | sha256sum -c - >&2`, options);
      options.progress?.("Preparing cached target dependencies");
      const dependencies = `${base}/dependencies/${dependencyKey}`;
      const depsStage = `${base}/dependencies/stage-${randomUUID()}`;
      const complete = `set -eu; umask 077; mkdir -p ${q(`${base}/dependencies`)} ${q(`${base}/builds`)}; if test ! -f ${q(`${dependencies}/ready`)}; then mkdir ${q(depsStage)}; trap ${q(`rm -rf ${q(depsStage)}`)} EXIT; cp ${q(`${stage}/package.json`)} ${q(`${stage}/package-lock.json`)} ${q(depsStage)}; cd ${q(depsStage)}; PATH=${q(dirname(node))}:"$PATH" ${q(npm)} ci --omit=dev --no-audit --no-fund >&2; touch ready; mv ${q(depsStage)} ${q(dependencies)}; fi; ln -s ${q(`${dependencies}/node_modules`)} ${q(`${stage}/node_modules`)}; touch ${q(`${stage}/ready`)}; if test ! -f ${q(`${directory}/ready`)}; then mv ${q(stage)} ${q(directory)}; fi`;
      await runRemote(
        host,
        `${prefix} flock -w 300 ${q(`${base}/provision.lock`)} sh -c ${q(complete)}`,
        options,
      );
      return { node, directory, home: probe.home, buildId, dependencyKey, transferred: true };
    })(),
    async () => {
      if (archive.exitCode === null) archive.kill();
      // Only the unique staging directory belongs to this attempt, never a live build/cache.
      const cleanup = { ...options };
      delete cleanup.signal;
      await runRemote(host, `${prefix} rm -rf ${q(stage)}`, cleanup);
    },
  );
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
  const child = remoteProcess(
    host,
    `exec env HARNESS_HOME=${q(runtime.home)} HARNESS_BUILD_ID=${q(runtime.buildId)} ${q(runtime.node)} ${q(`${runtime.directory}/server.mjs`)} ${allowStart ? "--bridge" : "--attach-only"}`,
    options,
    0,
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8192);
  });
  let ended = false;
  let failure: Error | undefined;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      failure = error;
      reject(error);
    });
    child.once("close", (code) => {
      ended = true;
      if (code === 0) resolve();
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
  const child = remoteProcess(
    host,
    `exec env HARNESS_HOME=${q(runtime.home)} HARNESS_BUILD_ID=${q(runtime.buildId)} ${q(runtime.node)} ${q(`${runtime.directory}/server.mjs`)} --bridge`,
    options,
    0,
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
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
  }
}
