import { strict as assert } from "node:assert";
import { spawn, execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { APPROVAL_CLIENT_CONTRACT_VERSION } from "@harness/approval";
import { FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { MCP_CLIENT_CONTRACT_VERSION } from "@harness/mcp/client";
import { PRODUCT_VERSION } from "@harness/release";
import { LOCAL_HOST, managementInspectRequest, type ServerIdentity } from "@harness/connections";
import {
  canonicalHome,
  readDiscovery,
  readServerSelection,
  stopServer,
} from "@harness/connections/node";
import {
  prepareServerLaunch,
  type PreparedServerLaunch,
} from "../../packages/cli/src/server-launch.ts";

// Run through scripts/development.mjs, after prepare:server. This exercises real
// native preparation and the exact desktop bridge without creating a window.
const workspace = resolve(import.meta.dirname, "../..");
const source = resolve(process.argv[2] ?? join(workspace, "packages/desktop/resources"));
const identity = JSON.parse(await readFile(join(source, "build.json"), "utf8")) as {
  target: string;
  nodeVersion: string;
};
const temporary = await mkdtemp(join(tmpdir(), "harness-desktop-smoke-"));
const home = await canonicalHome(join(temporary, "home"));
const payload = join(temporary, "source-payload");
const preparations: PreparedServerLaunch[] = [];
const originals = { ...process.env };
let passed = false;

async function stopAndWait(owner: ServerIdentity): Promise<void> {
  await stopServer(owner);
  const alive = () => {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  console.log(
    JSON.stringify({ event: "smoke.stop-observed", pid: owner.pid, processAlive: alive() }),
  );
  // Protocol/SQLite teardown may precede Node's physical exit. Its Windows cwd
  // handle still prevents removing the outside-checkout fixture directory.
  if (process.platform === "win32") {
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { $taskOwner = [System.Diagnostics.Process]::GetProcessById(${owner.pid}); } catch [System.ArgumentException] { exit 0 }; if (-not $taskOwner.WaitForExit(20000)) { throw 'Smoke owner did not physically exit' }`,
      ],
      { windowsHide: true, timeout: 25_000 },
    );
  } else {
    const deadline = performance.now() + 20_000;
    while (alive()) {
      if (performance.now() >= deadline) throw new Error("Smoke owner did not physically exit");
      await delay(10);
    }
  }
}

async function prepare(): Promise<PreparedServerLaunch> {
  const prepared = await prepareServerLaunch("background", AbortSignal.timeout(30_000));
  preparations.push(prepared);
  assert.notEqual(
    prepared.launch.executable,
    process.execPath,
    "server must use its captured shared runtime",
  );
  return prepared;
}

async function bridge<T>(
  prepared: PreparedServerLaunch,
  work: (client: HarnessClient, owner: ServerIdentity) => Promise<T>,
): Promise<T> {
  const launch = prepared.launch;
  const entry = launch.args[0];
  assert.ok(entry);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launch.env,
    HARNESS_PREPARED_SERVER: JSON.stringify({
      node: launch.executable,
      entry,
      payload: dirname(entry),
      keys: JSON.parse(launch.env?.["HARNESS_SERVER_CACHE_KEYS"] ?? "null") as unknown,
    }),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = spawn(
    launch.executable,
    [entry, "--host-bridge", JSON.stringify({ host: LOCAL_HOST, runtime: null })],
    {
      cwd: temporary,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once("close", resolveExit);
    child.once("error", reject);
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-8192);
  });
  const client = new HarnessClient({
    connection: createNdjsonMessageConnection(child.stdout, child.stdin),
    client: { name: "desktop-bootstrap-smoke", version: PRODUCT_VERSION },
    plugins: [
      { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
      { id: "mcp", version: MCP_CLIENT_CONTRACT_VERSION },
      ...FEATURE_PLUGIN_CONTRACTS,
    ],
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    await client.start();
    const owner = await client.peer.request(managementInspectRequest, {});
    return await work(client, owner);
  } catch (error) {
    throw new Error(`Prepared desktop bridge failed: ${diagnostics}`, { cause: error });
  } finally {
    client.closeConnection();
    child.stdin.end();
    const code = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0, diagnostics);
  }
}

try {
  const nodeDirectory = `${identity.nodeVersion}-${identity.target}`;
  await mkdir(join(home, "runtime/node"), { recursive: true });
  // The invoking managed bootstrap holds the verified source Node's use guard.
  await cp(
    join(workspace, ".harness-dev/runtime/node", nodeDirectory),
    join(home, "runtime/node", nodeDirectory),
    { recursive: true, verbatimSymlinks: true },
  );
  await cp(source, payload, { recursive: true, verbatimSymlinks: true });
  process.env["HARNESS_HOME"] = home;
  process.env["HARNESS_DEVELOPMENT_SERVER_PAYLOAD"] = payload;
  const rustTarget =
    identity.target === "windows-x64"
      ? "x86_64-pc-windows-msvc"
      : identity.target === "linux-x64-glibc"
        ? "x86_64-unknown-linux-gnu"
        : identity.target === "macos-arm64"
          ? "aarch64-apple-darwin"
          : "x86_64-apple-darwin";
  const launcher = join(
    workspace,
    "native/target",
    rustTarget,
    "debug",
    process.platform === "win32" ? "harness.exe" : "harness",
  );
  process.env["HARNESS_NATIVE_LAUNCHER"] = launcher;
  const version = await promisify(execFile)(launcher, ["--development", workspace, "--version"], {
    cwd: temporary,
    env: process.env,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(version.stdout.trim(), PRODUCT_VERSION);
  assert.equal(await readServerSelection(home), null, "source utilities must not select a server");
  const first = await prepare();
  let initial!: ServerIdentity;
  const conversation = await bridge(first, async (client, owner) => {
    initial = owner;
    return await client.create({ cwd: temporary });
  });
  assert.equal(
    (await readDiscovery(home))?.instanceId,
    initial.instanceId,
    "EOF must retain the owner",
  );
  assert.equal((await readServerSelection(home))?.directory, first.launch.selection);
  await first.close();
  preparations.splice(preparations.indexOf(first), 1);

  await writeFile(join(payload, "development-rebuild.txt"), "different complete source build\n");
  const rebuilt = await prepare();
  assert.notEqual(rebuilt.launch.selection, first.launch.selection);
  await bridge(rebuilt, async (client, owner) => {
    assert.equal(
      owner.instanceId,
      initial.instanceId,
      "source rebuild must attach to a live owner",
    );
    await client.attach(conversation.id);
    assert.equal((await readServerSelection(home))?.directory, first.launch.selection);
  });
  await stopAndWait(initial);

  let restarted!: ServerIdentity;
  await bridge(rebuilt, async (client, owner) => {
    restarted = owner;
    assert.notEqual(owner.instanceId, initial.instanceId);
    assert.equal(owner.serverId, initial.serverId, "data home must retain its identity");
    assert.equal((await readServerSelection(home))?.directory, rebuilt.launch.selection);
    await client.attach(conversation.id);
  });
  await stopAndWait(restarted);
  assert.equal(await readDiscovery(home), null);
  assert.equal(basename(dirname(rebuilt.launch.args[0]!)), rebuilt.launch.selection);
  passed = true;
} finally {
  try {
    const discovery = await readDiscovery(home);
    if (discovery !== null) await stopAndWait(discovery);
  } finally {
    await Promise.all(preparations.map((prepared) => prepared.close()));
    for (const key of Object.keys(process.env)) if (!(key in originals)) delete process.env[key];
    Object.assign(process.env, originals);
    if (passed) await rm(temporary, { recursive: true, force: true });
    else console.error(`Failed smoke evidence retained at ${temporary}`);
  }
}
console.log(
  "Prepared desktop bridge passed: exact shared Node, real RPC/SQLite, EOF persistence, live-owner reuse, explicit stop, rebuilt restart and physical retirement.",
);
