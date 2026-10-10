import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { APPROVAL_CLIENT_CONTRACT_VERSION } from "@harness/approval";
import { PRODUCT_VERSION, targetSchema } from "@harness/release";
import { canonicalHome } from "@harness/connections/node";
import { z } from "zod";

const source = resolve(process.argv[2] ?? "release/output/windows-x64");
const temporary = await mkdtemp(join(tmpdir(), "harness-payload-smoke-"));
const output = join(temporary, "payloads");
await cp(source, output, { recursive: true, verbatimSymlinks: true });
const { target } = z
  .object({ target: targetSchema })
  .parse(JSON.parse(await readFile(join(output, "server/build.json"), "utf8")));
const home = await canonicalHome(join(temporary, "home"));
const selection = `${PRODUCT_VERSION}-${target}`;
const payload = join(home, "server", selection);
await cp(join(output, "server"), payload, { recursive: true, verbatimSymlinks: true });
const serverNode = join(
  temporary,
  process.platform === "win32" ? "server-node.exe" : "server-node",
);
await cp(process.execPath, serverNode);
await mkdir(join(home, "server"), { recursive: true });
await writeFile(
  join(home, "server/current.json"),
  JSON.stringify({ formatVersion: 1, directory: selection }),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HARNESS_HOME: home,
  HARNESS_SERVER_ENTRY: join(payload, "server.mjs"),
  HARNESS_SERVER_PAYLOAD: payload,
  HARNESS_SERVER_NODE: serverNode,
  HARNESS_SERVER_SELECTION: "stale-inherited-selection",
};
delete env.NODE_OPTIONS;
delete env.HARNESS_NATIVE_BINDING;
delete env.NODE_PATH;
const execute = promisify(execFile);

async function server<T>(work: (client: HarnessClient) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, [join(output, "cli/cli.mjs"), "server", "--stdio"], {
    cwd: temporary,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
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
  const timeout = setTimeout(() => child.kill(), 30_000);
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  let code: number | null;
  try {
    result = await (async () => {
      await client.start();
      return work(client);
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    client.closeConnection();
    child.stdin.end();
    code = await exited;
  } finally {
    clearTimeout(timeout);
  }
  if (!result.ok) {
    throw new Error(`Standalone payload failed: ${diagnostic}`, { cause: result.error });
  }
  if (code !== 0) throw new Error(`Standalone server exited ${String(code)}: ${diagnostic}`);
  return result.value;
}

try {
  const { stdout } = await execute(process.execPath, [join(output, "cli/cli.mjs"), "--version"], {
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
  await rm(temporary, { recursive: true, force: true });
}
