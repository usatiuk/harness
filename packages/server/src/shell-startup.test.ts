import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readDiscovery } from "@harness/connections/local";
import { stopServer } from "@harness/connections/node";

const exec = promisify(execFile);
const moduleUrl = (path: string) => pathToFileURL(resolve(path)).href;

it.skipIf(process.platform === "win32" || !existsSync("/bin/bash"))(
  "initializes a cold GUI-style owner and does not import a later client's environment",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-cold-shell owner-"));
    const home = join(root, "harness");
    const account = join(root, "account");
    const bin = join(account, "startup bin");
    const entry = join(root, "owner.mjs");
    await mkdir(home, { mode: 0o700 });
    await mkdir(bin, { recursive: true });
    await writeFile(join(account, ".bash_profile"), 'source "$HOME/.bashrc"\n');
    await writeFile(
      join(account, ".bashrc"),
      [
        "[[ $- == *i* ]] || return",
        'export PATH="$HOME/startup bin:$PATH"',
        'export STARTUP_TEST_VALUE="from guarded rc"',
        'export HARNESS_HOME="/must-not-replace-the-owning-home"',
        'printf "startup noise is not RPC or environment data\\n"',
      ].join("\n"),
    );
    await writeFile(join(bin, "startup-only-tool"), '#!/bin/sh\nprintf "startup-tool-ok\\n"\n', {
      mode: 0o700,
    });
    await writeFile(join(home, "AGENTS.md"), "GLOBAL STARTUP GUIDANCE");
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        version: 1,
        model: { provider: "demo", model: "demo-1" },
        plugins: {
          sandbox: { backend: "none" },
          approval: { tools: { bash: "allow", zsh: "allow" } },
        },
      }),
    );
    await writeFile(
      entry,
      `import { DemoProvider } from ${JSON.stringify(moduleUrl("packages/server/src/demo-provider.ts"))};
import { runBackgroundServer } from ${JSON.stringify(moduleUrl("packages/server/src/background.ts"))};
import { textOf } from ${JSON.stringify(moduleUrl("packages/protocol/src/index.ts"))};
DemoProvider.prototype.stream = async function* (request) {
  const command = request.tools?.find(tool => tool.name === "bash" || tool.name === "zsh");
  const last = request.items.at(-1)?.item;
  if (command && last?.type !== "tool_result") {
    if (!textOf(request.instructions).includes("GLOBAL STARTUP GUIDANCE"))
      throw new Error("Global instructions did not reach the actual owner request");
    yield { type: "tool_call", callId: "inspect-environment", name: command.name,
      args: { command: 'printf "VALUE=%s\\n" "$STARTUP_TEST_VALUE"; startup-only-tool' } };
  } else {
    yield { type: "message", content: [{ type: "text", text: "Finished" }] };
  }
  yield { type: "completed", usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } };
};
await runBackgroundServer();\n`,
    );
    const clientCode = `
import { HarnessClient } from ${JSON.stringify(moduleUrl("packages/client/src/index.ts"))};
import { ensureLocalServer } from ${JSON.stringify(moduleUrl("packages/connections/src/node.ts"))};
const host = await ensureLocalServer(process.env.HARNESS_HOME, {
  executable: process.execPath,
  args: ["--conditions=development", "--import=tsx", ${JSON.stringify(entry)}],
  env: process.env,
});
const client = new HarnessClient({connection: host.connection, client: {name: "isolated-client", version: "1"}});
try {
  await client.start();
  const conversation = await client.create({overrides: {instructions: "ROOT ROLE", tools: {mode: "hybrid"}}});
  await client.attach(conversation.id);
  const terminal = new Promise(resolve => client.subscribe(event => {
    if (event.type === "conversation" && event.conversationId === conversation.id &&
        event.event.type === "turn.changed" && event.event.status !== "running") resolve(event.event);
  }));
  await client.deliver(conversation.id, "inspect environment", "send");
  const outcome = await terminal;
  const history = await client.history({conversationId: conversation.id});
  console.log(JSON.stringify({pid: host.identity.pid, outcome, history}));
} finally {
  client.closeConnection();
  host.close();
}
`;
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: account,
      SHELL: "/bin/bash",
      HARNESS_HOME: home,
      ...(process.env["TMPDIR"] ? { TMPDIR: process.env["TMPDIR"] } : {}),
    };
    const args = [
      "--conditions=development",
      "--import=tsx",
      "--input-type=module",
      "-e",
      clientCode,
    ];
    const runClient = async (env: NodeJS.ProcessEnv) => {
      const result = await exec(process.execPath, args, {
        cwd: resolve("."),
        env,
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(result.stdout) as {
        pid: number;
        outcome: { status: string; error: string | null };
        history: unknown;
      };
    };
    try {
      const first = await runClient(cleanEnv);
      expect(first.outcome).toMatchObject({ status: "completed", error: null });
      expect(JSON.stringify(first.history)).toContain("VALUE=from guarded rc");
      expect(JSON.stringify(first.history)).toContain("startup-tool-ok");
      const second = await runClient({
        ...cleanEnv,
        PATH: "/client-only-path",
        SHELL: "/not-a-shell",
      });
      expect(second.pid).toBe(first.pid);
      expect(second.outcome).toMatchObject({ status: "completed", error: null });
      expect(JSON.stringify(second.history)).toContain("VALUE=from guarded rc");
      expect(JSON.stringify(second.history)).toContain("startup-tool-ok");
    } finally {
      const discovery = await readDiscovery(home);
      if (discovery) await stopServer(discovery);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
