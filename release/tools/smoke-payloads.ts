import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { APPROVAL_CLIENT_CONTRACT_VERSION } from "@harness/approval";
import {
  PRODUCT_VERSION,
  targetSchema,
  releaseManifestSchema,
  type ReleaseArtifact,
} from "@harness/release";
import { verifyRelease } from "@harness/native";
import { fileIdentity } from "./artifacts.ts";
import { preparedServerSchema } from "@harness/connections/node";
import { canonicalHome } from "@harness/connections/node";
import { z } from "zod";
import { smokeProcessDeadline } from "./smoke-process.ts";

const source = resolve(process.argv[2] ?? "release/output/windows-x64");
const temporary = await mkdtemp(join(tmpdir(), "harness-payload-smoke-"));
const activeProcesses = new Set<ReturnType<typeof spawn>>();
try {
  const output = join(temporary, "payloads");
  await mkdir(output);
  for (const component of ["cli", "server"])
    await cp(join(source, component), join(output, component), {
      recursive: true,
      verbatimSymlinks: true,
    });
  const { target, mode, sourceCommit } = z
    .object({
      target: targetSchema,
      mode: z.enum(["development", "release"]),
      sourceCommit: z.string(),
    })
    .parse(JSON.parse(await readFile(join(output, "server/build.json"), "utf8")));
  const home = await canonicalHome(join(temporary, "home"));
  const selection = `${PRODUCT_VERSION}-${target}`;
  const payload = join(home, "server", selection);
  const serverNode = join(
    temporary,
    process.platform === "win32" ? "server-node.exe" : "server-node",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_HOME: home,
  };
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "HARNESS_NATIVE_BINDING",
    "HARNESS_NATIVE_LAUNCHER",
    "HARNESS_DEVELOPMENT_SERVER_PAYLOAD",
    "HARNESS_SERVER_ENTRY",
    "HARNESS_SERVER_PAYLOAD",
    "HARNESS_SERVER_NODE",
    "HARNESS_SERVER_SELECTION",
    "HARNESS_SERVER_CACHE_KEYS",
  ])
    delete env[name];
  const execute = promisify(execFile);
  let executable = process.execPath;
  let entryArgs = [join(output, "cli/cli.mjs")];

  /** Seed only the CLI fixture cache. Server/Node use the real offline installer;
   * cached CLI verification and execution use the actual native launcher. Cold CLI
   * HTTPS installation is a separate anonymous-publication qualification. */
  async function prepareSignedFixture(directory: string): Promise<void> {
    const metadata = join(directory, "release.json");
    const signature = join(directory, "release.json.minisig");
    const manifest = releaseManifestSchema.parse(
      JSON.parse(verifyRelease(await readFile(metadata), await readFile(signature, "utf8"))),
    );
    if (manifest.productVersion !== PRODUCT_VERSION || manifest.sourceCommit !== sourceCommit)
      throw new Error("Signed smoke metadata does not match the built payload");
    const contents = manifest.targets[target];
    if (!contents) throw new Error("Signed smoke metadata does not support the payload target");
    const asset = async (artifact: ReleaseArtifact): Promise<string> => {
      const name = decodeURIComponent(basename(new URL(artifact.url).pathname));
      if (basename(name) !== name || name.includes("\\"))
        throw new Error("Unsafe smoke asset name");
      const path =
        artifact === contents.node.artifact
          ? join(directory, "runtime", name)
          : join(directory, name);
      const actual = await fileIdentity(path);
      if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
        throw new Error("Signed smoke asset differs from its verified metadata");
      return path;
    };
    const launcher = join(temporary, process.platform === "win32" ? "harness.exe" : "harness");
    await cp(await asset(contents.launcher), launcher);
    const identity = z
      .object({
        mode: z.literal("release"),
        productVersion: z.string(),
        sourceCommit: z.string(),
        target: targetSchema,
      })
      .parse(
        JSON.parse((await execute(launcher, ["--build-info"], { env, windowsHide: true })).stdout),
      );
    if (
      identity.mode !== "release" ||
      identity.productVersion !== manifest.productVersion ||
      identity.sourceCommit !== manifest.sourceCommit ||
      identity.target !== target
    )
      throw new Error("Actual smoke launcher identity differs from signed metadata");
    const child = spawn(
      launcher,
      [
        "--install-transferred-server",
        JSON.stringify({
          kind: "release",
          version: PRODUCT_VERSION,
          manifest: metadata,
          signature,
          nodeArchive: await asset(contents.node.artifact),
          serverArchive: await asset(contents.server),
        }),
      ],
      {
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    activeProcesses.add(child);
    child.once("close", () => activeProcesses.delete(child));
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    const deadline = smokeProcessDeadline(child, exited, 60_000);
    const readiness = await Promise.race([
      deadline.expired,
      new Promise<void>((resolveReady, reject) => {
        let bytes = Buffer.alloc(0);
        child.once("error", reject);
        child.once("close", () =>
          reject(new Error(`Signed installation exited before readiness: ${diagnostic}`)),
        );
        child.stdout.on("data", (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, chunk]);
          try {
            if (bytes.length > 16_384)
              throw new Error("Signed installation descriptor exceeds its bound");
            const newline = bytes.indexOf(10);
            if (newline < 0) return;
            const prepared = preparedServerSchema
              .extend({
                home: z.string().min(1),
                keys: z.tuple([
                  z.literal(`node-${contents.node.version}-${target}`),
                  z.literal(`server-${selection}`),
                ]),
              })
              .parse(JSON.parse(bytes.subarray(0, newline).toString()));
            for (const [actual, expected] of [
              [prepared.home, home],
              [prepared.payload, payload],
              [prepared.entry, join(payload, "server.mjs")],
              [
                prepared.node,
                join(
                  home,
                  "runtime/node",
                  `${contents.node.version}-${target}`,
                  contents.node.artifact.entry,
                ),
              ],
            ] as const)
              if (resolve(actual) !== resolve(expected))
                throw new Error("Signed installer returned a different cache path");
            resolveReady();
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("Invalid installation descriptor", { cause: error }),
            );
          }
        });
      }),
    ]).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    child.stdin.end();
    const code = await deadline.finish();
    if (!readiness.ok)
      throw new Error(`Signed offline installation did not become ready: ${diagnostic}`, {
        cause: readiness.error,
      });
    if (code !== 0) throw new Error(`Signed offline installation failed: ${diagnostic}`);
    const cli = join(home, "cli", selection);
    const unpacked = join(temporary, "cli-fixture");
    await mkdir(unpacked);
    const archive = await asset(contents.cli);
    await execute("tar", ["-xzf", archive, "-C", unpacked], { windowsHide: true });
    await mkdir(join(home, "cli"));
    await cp(join(unpacked, contents.cli.root), cli, { recursive: true, verbatimSymlinks: true });
    await writeFile(
      join(cli, "receipt.json"),
      JSON.stringify({
        formatVersion: 1,
        component: "cli",
        version: PRODUCT_VERSION,
        target,
        artifact: contents.cli,
        nodeVersion: contents.node.version,
      }),
    );
    await cp(metadata, join(cli, "release.json"));
    await cp(signature, join(cli, "release.json.minisig"));
    executable = launcher;
    entryArgs = [];
  }

  async function server<T>(work: (client: HarnessClient) => Promise<T>): Promise<T> {
    const child = spawn(executable, [...entryArgs, "server", "--stdio"], {
      cwd: temporary,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeProcesses.add(child);
    child.once("close", () => activeProcesses.delete(child));
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    const client = new HarnessClient({
      connection: createNdjsonMessageConnection(child.stdout, child.stdin),
      client: { name: "payload-smoke", version: PRODUCT_VERSION },
      plugins: [
        { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
        ...FEATURE_PLUGIN_CONTRACTS,
      ],
    });
    const deadline = smokeProcessDeadline(child, exited, 30_000);
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    let code: number | null;
    try {
      const operation = (async () => {
        await client.start();
        return work(client);
      })().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      result = await Promise.race([
        operation,
        deadline.expired,
        exited.then((exitCode) => ({
          ok: false as const,
          error: new Error(`Standalone server retired during smoke work: ${String(exitCode)}`),
        })),
      ]);
    } finally {
      client.closeConnection();
      child.stdin.end();
      code = await deadline.finish();
    }
    if (!result.ok) {
      throw new Error(`Standalone payload failed: ${diagnostic}`, { cause: result.error });
    }
    if (code !== 0) throw new Error(`Standalone server exited ${String(code)}: ${diagnostic}`);
    return result.value;
  }

  if (mode === "release") {
    if (!process.argv[3])
      throw new Error("Release payload smoke requires its signed assembled artifact directory");
    await prepareSignedFixture(resolve(process.argv[3]));
  } else {
    await cp(join(output, "server"), payload, { recursive: true, verbatimSymlinks: true });
    await cp(process.execPath, serverNode);
    await writeFile(
      join(home, "server/current.json"),
      JSON.stringify({ formatVersion: 1, directory: selection }),
    );
    env.HARNESS_SERVER_ENTRY = join(payload, "server.mjs");
    env.HARNESS_SERVER_PAYLOAD = payload;
    env.HARNESS_SERVER_NODE = serverNode;
    env.HARNESS_SERVER_SELECTION = "stale-inherited-selection";
  }
  const { stdout } = await execute(executable, [...entryArgs, "--version"], {
    cwd: temporary,
    env,
    windowsHide: true,
    timeout: 30_000,
  });
  if (stdout.trim() !== PRODUCT_VERSION)
    throw new Error("Standalone CLI reports the wrong product version");
  const id = await server(async (client) => {
    const conversation = await client.create({
      cwd: temporary,
      overrides: {
        tools: { mode: "code-only" },
        plugins: { approval: { tools: { powershell: "allow", bash: "allow" } } },
      },
    });
    await client.attach(conversation.id);
    const completed = new Promise<void>((resolveTurn, reject) => {
      const unsubscribe = client.subscribe((event) => {
        if (
          event.type !== "conversation" ||
          event.conversationId !== conversation.id ||
          event.event.type !== "turn.changed" ||
          event.event.status === "running"
        )
          return;
        unsubscribe();
        if (event.event.status === "completed") resolveTurn();
        else reject(new Error(`Smoke turn ${event.event.status}`));
      });
    });
    await client.deliver(conversation.id, "hello standalone payload", "send");
    await completed;
    return conversation.id;
  });
  await server(async (client) => {
    await client.attach(id);
    const history = await client.history({ conversationId: id });
    if (!JSON.stringify(history.entries).includes("hello standalone payload"))
      throw new Error("Standalone SQLite history did not survive restart");
  });
  console.log(
    "Standalone CLI version, selected-server RPC/demo turn and SQLite restart passed outside the checkout.",
  );
} finally {
  if (activeProcesses.size === 0) await rm(temporary, { recursive: true, force: true });
  else
    process.stderr.write(
      `Retained failed smoke scratch ${temporary}; process retirement unconfirmed for parent PIDs ${[...activeProcesses].map((child) => child.pid).join(", ")}\n`,
    );
}
