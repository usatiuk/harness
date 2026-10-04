import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createConnection } from "node:net";
import { expect, it, vi } from "vitest";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { ensureLocalServer, stopServer, replaceJson } from "@harness/connections/node";
import { canonicalHome, privateRuntimeDirectory, readDiscovery } from "@harness/connections/local";
import { serverInfoRequest } from "@harness/connections";
import { ApprovalClient, APPROVAL_CLIENT_CONTRACT_VERSION } from "@harness/approval";
import { textOf } from "@harness/protocol";

const entry = resolve("packages/server/src/bin.ts");
const args = ["--conditions=development", "--import=tsx", entry];
const launch = { executable: process.execPath, args: [...args, "--background"] };
const exec = promisify(execFile);

it.each(["waiter", "bridge"])(
  "cancels a Local %s before readiness without killing its launched owner",
  async (mode) => {
    const home = await canonicalHome(join(tmpdir(), `harness-cancel-start-${randomUUID()}`));
    const fixture = join(home, "delayed.mjs");
    const marker = join(home, "started");
    const gate = join(home, "release");
    const delayedLaunch = {
      executable: process.execPath,
      args: ["--conditions=development", "--import=tsx", fixture, "--background"],
    };
    let bridge: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(
        fixture,
        `import {watch,existsSync,writeFileSync} from 'node:fs';
const gate=${JSON.stringify(gate)};
await new Promise(resolve=>{const watcher=watch(${JSON.stringify(home)},()=>{if(existsSync(gate)){watcher.close();resolve()}});writeFileSync(${JSON.stringify(marker)},String(process.pid));});
await import(${JSON.stringify(pathToFileURL(entry).href)});`,
      );
      const abort = new AbortController();
      let cancelled: Promise<unknown>;
      if (mode === "waiter") {
        cancelled = ensureLocalServer(home, delayedLaunch, abort.signal);
        // Register rejection observation before cancellation.
        void cancelled.catch(() => undefined);
      } else {
        const runner = join(home, "bridge.mjs");
        await writeFile(
          runner,
          `const {runLocalBridge}=await import(${JSON.stringify(pathToFileURL(resolve("packages/connections/src/connect.ts")).href)});await runLocalBridge(${JSON.stringify(home)},${JSON.stringify(delayedLaunch)});`,
        );
        bridge = spawn(process.execPath, ["--conditions=development", "--import=tsx", runner], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        cancelled = once(bridge, "close");
      }
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toMatch(/^\d+$/u), {
        timeout: 10_000,
      });
      const pid = Number(await readFile(marker, "utf8"));
      if (bridge) bridge.stdin!.end();
      else abort.abort();
      if (mode === "waiter") await expect(cancelled).rejects.toThrow();
      else expect(await cancelled).toEqual([0, null]);
      // The owner is still gated when the observer has already left.
      expect(await readDiscovery(home)).toBeNull();
      await writeFile(gate, "release");
      await vi.waitFor(async () => expect((await readDiscovery(home))?.pid).toBe(pid), {
        timeout: 10_000,
      });
      const fresh = await ensureLocalServer(home, launch);
      expect(fresh.identity.pid).toBe(pid);
      fresh.close();
    } finally {
      if (bridge?.exitCode === null) bridge.kill();
      await writeFile(gate, "release");
      if (await readFile(marker, "utf8").catch(() => null))
        await vi.waitFor(async () => expect(await readDiscovery(home)).not.toBeNull(), {
          timeout: 10_000,
        });
      await stopHome(home);
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
async function stopHome(home: string): Promise<void> {
  const discovery = await readDiscovery(home);
  if (discovery === null) return;
  try {
    await stopServer(discovery);
  } catch (error) {
    // A deliberately crashed fixture leaves stale discovery, but no live owner.
    if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
  }
}

it("converges simultaneous starters, rejects unauthenticated peers and survives bridge exit", async () => {
  const home = join(tmpdir(), `harness-background-${randomUUID()}`);
  try {
    const [first, second] = await Promise.all([
      ensureLocalServer(home, launch),
      ensureLocalServer(home, launch),
    ]).catch(async (error: unknown) => {
      throw new Error(await readFile(join(home, ".server", "startup.log"), "utf8"), {
        cause: error,
      });
    });
    expect(second.identity).toEqual(first.identity);
    second.close();
    const discovery = await readDiscovery(home);
    if (discovery === null) throw new Error("Missing discovery");
    const unauthorized = createConnection({ host: "127.0.0.1", port: discovery.port });
    await once(unauthorized, "connect");
    unauthorized.write("wrong-token\n");
    await once(unauthorized, "close");
    const bridge = spawn(process.execPath, [...args, "--bridge"], {
      env: { ...process.env, HARNESS_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let diagnostics = "";
    bridge.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    const closed = once(bridge, "close");
    const client = new HarnessClient({
      connection: createNdjsonMessageConnection(bridge.stdout, bridge.stdin),
      client: { name: "process-test", version: "1" },
      plugins: [{ id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION }],
    });
    const approvals = new ApprovalClient(client);
    await client.start();
    expect(await client.peer.request(serverInfoRequest, {})).toEqual(first.identity);
    const conversation = await client.create({
      cwd: await isolatedWorkspace(home),
      overrides: { model: { provider: "demo", model: "demo-1" } },
    });
    await client.attach(conversation.id);
    let pendingId: string | undefined;
    let approvalReady!: () => void;
    const pending = new Promise<void>((resolve) => {
      approvalReady = resolve;
    });
    approvals.subscribe(conversation.id, (event) => {
      if (event.type === "created") {
        pendingId = event.approval.requestId;
        approvalReady();
      }
    });
    await client.deliver(conversation.id, "survive the last client", "send");
    await pending;
    first.close();
    client.closeConnection();
    const result: unknown[] = await closed;
    expect(diagnostics).toBe("");
    expect(result[0]).toBe(0);
    const fresh = await ensureLocalServer(home, launch);
    expect(fresh.identity).toEqual(first.identity);
    const reconnect = new HarnessClient({
      connection: fresh.connection,
      client: { name: "reconnected", version: "1" },
      plugins: [{ id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION }],
    });
    const restored = new ApprovalClient(reconnect);
    let restoredId: string | undefined;
    restored.subscribe(conversation.id, (event) => {
      if (event.type === "created") restoredId = event.approval.requestId;
    });
    await reconnect.start();
    expect((await reconnect.get(conversation.id))?.id).toBe(conversation.id);
    await reconnect.attach(conversation.id);
    expect(restoredId).toBe(pendingId);
    let turnDone!: (status: string) => void;
    const completed = new Promise<string>((resolve) => {
      turnDone = resolve;
    });
    reconnect.subscribe((event) => {
      if (
        event.type === "conversation" &&
        event.event.type === "turn.changed" &&
        event.event.status !== "running"
      )
        turnDone(event.event.status);
    });
    await restored.respond(restoredId!, "allow");
    expect(await completed).toBe("completed");
    const history = await reconnect.history({ conversationId: conversation.id });
    const items = history.entries.flatMap((entry) => (entry.kind === "item" ? [entry.item] : []));
    const assistant = items.find((item) => item.type === "message" && item.role === "assistant");
    expect(assistant?.type === "message" ? textOf(assistant.content) : undefined).toBe(
      "Done — ran your message through the command tool.",
    );
    const resultItem = items.find((item) => item.type === "tool_result");
    expect(resultItem).toMatchObject({ status: "ok" });
    expect(resultItem?.type === "tool_result" ? textOf(resultItem.content) : undefined).toContain(
      "survive the last client",
    );
    reconnect.closeConnection();
    fresh.close();
    await stopHome(home);
    expect(await readDiscovery(home)).toBeNull();
    const restarted = await ensureLocalServer(home, launch);
    expect(restarted.identity.serverId).toBe(first.identity.serverId);
    expect(restarted.identity.instanceId).not.toBe(first.identity.instanceId);
  } catch (error) {
    throw new Error(await readFile(join(home, ".server", "startup.log"), "utf8"), { cause: error });
  } finally {
    await stopHome(home);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

async function isolatedWorkspace(home: string): Promise<string> {
  const workspace = join(home, "workspace");
  // A project marker bounds discovery before it can reach real account settings.
  await mkdir(join(workspace, ".harness"), { recursive: true });
  return workspace;
}

it("does not claim shutdown succeeded when a live server's discovery disappears", async () => {
  const home = join(tmpdir(), `harness-background-missing-${randomUUID()}`);
  const host = await ensureLocalServer(home, launch);
  const discovery = await readDiscovery(home);
  if (discovery === null) throw new Error("Missing fixture discovery");
  try {
    await rm(join(home, ".server", "discovery.json"));
    await expect(stopServer(host.identity)).rejects.toThrow("shutdown outcome is unknown");
    const observer = new HarnessClient({
      connection: host.connection,
      client: { name: "unknown-stop-test", version: "1" },
    });
    await observer.start();
    expect(await observer.peer.request(serverInfoRequest, {})).toEqual(host.identity);
    observer.closeConnection();
  } finally {
    await replaceJson(join(home, ".server", "discovery.json"), discovery);
    host.close();
    await stopServer(host.identity);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("keeps the daemon alive after its bridge parent process exits", async () => {
  const home = join(tmpdir(), `harness-background-parent-${randomUUID()}`);
  const bridge = spawn(process.execPath, [...args, "--bridge"], {
    env: { ...process.env, HARNESS_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = once(bridge, "close");
  const client = new HarnessClient({
    connection: createNdjsonMessageConnection(bridge.stdout, bridge.stdin),
    client: { name: "parent-exit-test", version: "1" },
  });
  let identity: Awaited<ReturnType<typeof ensureLocalServer>>["identity"] | undefined;
  try {
    await client.start();
    identity = await client.peer.request(serverInfoRequest, {});
    client.closeConnection();
    const result: unknown[] = await exited;
    expect(result[0]).toBe(0);
    const fresh = await ensureLocalServer(home, launch);
    expect(fresh.identity).toEqual(identity);
    fresh.close();
  } finally {
    client.closeConnection();
    if (bridge.exitCode === null) bridge.kill();
    await exited;
    await stopHome(home);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("rejects an existing home writable by other users without starting or changing it", async () => {
  const home = await canonicalHome(join(tmpdir(), `harness-background-unsafe-${randomUUID()}`));
  try {
    if (process.platform === "win32")
      await exec("icacls.exe", [home, "/grant", "*S-1-1-0:(OI)(CI)M"], { windowsHide: true });
    else await chmod(home, 0o777);
    await expect(ensureLocalServer(home, launch)).rejects.toThrow("writable by other users");
    await expect(stat(join(home, "store.db"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canonicalHome(home)).rejects.toThrow("writable by other users");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 10000);

it("retries classified startup contention but never retries a broken entry point", async () => {
  const home = await canonicalHome(join(tmpdir(), `harness-background-startup-${randomUUID()}`));
  const marker = join(home, "attempts");
  const fixture = join(home, "startup.mjs");
  let identity: Awaited<ReturnType<typeof ensureLocalServer>>["identity"] | undefined;
  try {
    await writeFile(
      fixture,
      `import {appendFile,writeFile} from 'node:fs/promises';await appendFile(${JSON.stringify(marker)},'attempt\\n');try{await writeFile(${JSON.stringify(join(home, "contention"))},'seen',{flag:'wx'});process.exitCode=76;}catch(error){if(error.code!=='EEXIST')throw error;await import(${JSON.stringify(pathToFileURL(entry).href)});}`,
    );
    const host = await ensureLocalServer(home, {
      executable: process.execPath,
      args: ["--conditions=development", "--import=tsx", fixture, "--background"],
    });
    identity = host.identity;
    expect(await readFile(marker, "utf8")).toBe("attempt\nattempt\n");
    host.close();
    await stopServer(identity);
    identity = undefined;
    await writeFile(
      fixture,
      `import {appendFile} from 'node:fs/promises';await appendFile(${JSON.stringify(marker)},'broken\\n');process.exitCode=1;`,
    );
    await expect(
      ensureLocalServer(home, { executable: process.execPath, args: [fixture] }),
    ).rejects.toThrow("exit 1");
    expect(await readFile(marker, "utf8")).toBe("attempt\nattempt\nbroken\n");
  } finally {
    await stopHome(home);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("rejects discovery copied from another directory", async () => {
  const home = join(tmpdir(), `harness-background-copy-${randomUUID()}`);
  const other = await canonicalHome(join(tmpdir(), `harness-background-copy-${randomUUID()}`));
  let owner: Awaited<ReturnType<typeof ensureLocalServer>> | undefined;
  try {
    owner = await ensureLocalServer(home, launch);
    await privateRuntimeDirectory(other);
    await cp(join(home, ".server"), join(other, ".server"), { recursive: true });
    await expect(ensureLocalServer(other, launch)).rejects.toThrow("another Harness home");
    expect((await readDiscovery(home))?.instanceId).toBe(owner.identity.instanceId);
  } finally {
    if (owner !== undefined) {
      owner.close();
    }
    await stopHome(home);
    await rm(home, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
}, 30000);

it("recovers stale discovery after a crashed owner and canonicalizes equivalent home routes", async () => {
  const home = join(tmpdir(), `harness-background-crash-${randomUUID()}`);
  try {
    const first = await ensureLocalServer(home, launch);
    const client = new HarnessClient({
      connection: first.connection,
      client: { name: "crash-test", version: "1" },
    });
    await client.start();
    const closed = new Promise<void>((resolve) => first.connection.onClose(() => resolve()));
    process.kill(first.identity.pid, "SIGKILL");
    await closed;
    expect((await readDiscovery(home))?.instanceId).toBe(first.identity.instanceId);
    const replacement = await ensureLocalServer(join(home, "."), launch).catch(
      async (error: unknown) => {
        throw new Error(await readFile(join(home, ".server", "startup.log"), "utf8"), {
          cause: error,
        });
      },
    );
    expect(replacement.identity.serverId).toBe(first.identity.serverId);
    expect(replacement.identity.instanceId).not.toBe(first.identity.instanceId);
    const alias = await ensureLocalServer(join(home, "..", home.split(/[\\/]/u).at(-1)!), launch);
    expect(alias.identity).toEqual(replacement.identity);
    alias.close();
    const active = new HarnessClient({
      connection: replacement.connection,
      client: { name: "active-client-stop", version: "1" },
    });
    await active.start();
    await stopServer(replacement.identity);
    expect(active.peer.ready).toBe(false);
  } finally {
    await stopHome(home);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
