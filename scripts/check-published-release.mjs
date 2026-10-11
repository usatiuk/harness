import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";

const [cli, desktop, previous, version] = process.argv.slice(2);
const run = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 180_000 });
async function session(file, args, inspect, { closeInput = true, env = process.env } = {}) {
  const child = spawn(file, args, { windowsHide: true, env });
  const deadline = setTimeout(() => child.kill(), 180_000);
  const closed = once(child, "close");
  let diagnostics = "";
  child.stderr.on("data", (chunk) => (diagnostics += chunk));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    for (;;) {
      const next = await lines.next();
      assert.equal(next.done, false, diagnostics);
      const response = JSON.parse(next.value);
      if (response.id !== id) continue;
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    }
  };
  try {
    return await inspect(request, lines);
  } finally {
    // Preparation exits itself; EOF is its cancellation signal.
    if (closeInput) child.stdin.end();
    try {
      assert.equal((await closed)[0], 0, diagnostics);
    } finally {
      clearTimeout(deadline);
    }
  }
}
async function conversation(file, args, expected, existing, env = process.env) {
  return session(
    file,
    args,
    async (request) => {
      const initialized = await request("initialize", {
        protocolVersion: 4,
        client: { name: "published-release-check", version: "1" },
        plugins: [],
      });
      assert.equal(initialized.server.version, expected);
      const result = existing
        ? await request("conversation.get", { conversationId: existing })
        : await request("conversation.create", { cwd: null, overrides: {} });
      assert.ok(result.id);
      if (existing) assert.equal(result.id, existing);
      return result.id;
    },
    { env },
  );
}

assert.equal(run(cli, ["--version"]).trim(), previous);
run(cli, ["--help"]);
const id = await conversation(cli, ["server", "--stdio"], previous);
const oldCli = join(
  dirname(cli),
  `old-${process.platform === "win32" ? "harness.exe" : "harness"}`,
);
await copyFile(cli, oldCli);
console.log(run(cli, ["update"]));
assert.equal(run(cli, ["--version"]).trim(), version);
await conversation(cli, ["server", "--stdio"], version, id);
await conversation(oldCli, ["server", "--stdio"], version, id);

const paths = await session(
  desktop,
  [
    "--prepare-runtime",
    JSON.stringify({ home: process.env.HARNESS_HOME, developmentPayload: null, local: true }),
  ],
  async (_request, lines) => {
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  },
  { closeInput: false },
);
assert.equal(relative(process.env.HARNESS_HOME, paths.node).startsWith(".."), false);
assert.equal((await readdir(join(process.env.HARNESS_HOME, "runtime/node"))).length, 1);
await conversation(paths.node, [paths.entry, "--stdio"], version, id, {
  ...process.env,
  HARNESS_SERVER_SELECTION: basename(paths.payload),
});
assert.match(run(cli, ["update"]), /is up to date/);
console.log(
  "Cold published CLI/server, CLI update, no downgrade, SQLite persistence and installed desktop preparation passed",
);
