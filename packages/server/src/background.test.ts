import {
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createConnection } from "node:net";
import { expect, it, vi, onTestFailed } from "vitest";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import {
  attachLocalServer,
  ensureLocalServer,
  stopServer,
  replaceJson,
} from "@harness/connections/node";
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
    const started = performance.now();
    const phases: { phase: string; ms: number }[] = [];
    const phase = (phase: string) => phases.push({ phase, ms: performance.now() - started });
    const requestedHome = join(tmpdir(), `harness-cancel-start-${randomUUID()}`);
    const fixtureLog = join(requestedHome, ".server", "startup.log");
    const describeError = (error: unknown) =>
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { type: typeof error };
    const diagnose = async (event: string, error?: unknown) => {
      const observedPhases = phases.slice();
      const child = await readFile(fixtureLog, "utf8")
        .then((log) =>
          log.split("\n").filter((line) => line.startsWith('{"event":"fixture-phase",')),
        )
        .catch((error) => ({ readError: describeError(error) }));
      console.error(
        JSON.stringify({
          event,
          mode,
          phases: observedPhases,
          child,
          ...(error === undefined ? {} : { error: describeError(error) }),
        }),
      );
    };
    onTestFailed(() => diagnose("cancellation.diagnostic"));
    phase("prepare-home");
    const home = await canonicalHome(requestedHome);
    phase("prepared-home");
    const fixture = join(home, "delayed.mjs");
    const marker = join(home, "started");
    const gate = join(home, "release");
    const delayedLaunch = {
      executable: process.execPath,
      args: ["--conditions=development", "--import=tsx", fixture, "--background"],
    };
    let bridge: ReturnType<typeof spawn> | undefined;
    const abort = new AbortController();
    try {
      await writeFile(
        fixture,
        `import {watch,existsSync,writeFileSync} from 'node:fs';
const start=performance.now();
const phase=phase=>console.error(JSON.stringify({event:'fixture-phase',pid:process.pid,phase,ms:performance.now()-start}));
const gate=${JSON.stringify(gate)};
await new Promise(resolve=>{const check=()=>{if(existsSync(gate)){watcher.close();phase('gate-open');resolve()}};const watcher=watch(${JSON.stringify(home)},check);phase('gate-installed');writeFileSync(${JSON.stringify(marker)},String(process.pid));check();});
phase('import-entry');
await import(${JSON.stringify(pathToFileURL(entry).href)});
phase('entry-returned');`,
      );
      let cancelled: Promise<unknown>;
      phase("launch-observer");
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
      phase("await-marker");
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toMatch(/^\d+$/u), {
        timeout: 10_000,
      });
      const pid = Number(await readFile(marker, "utf8"));
      phase("cancel-observer");
      if (bridge) bridge.stdin!.end();
      else abort.abort();
      if (mode === "waiter") await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      else expect(await cancelled).toEqual([0, null]);
      phase("cancelled-observer");
      // The owner is still gated when the observer has already left.
      expect(await readDiscovery(home)).toBeNull();
      await writeFile(gate, "release");
      phase("await-discovery");
      // The gated entry still has its cold imports ahead of it. Qualify readiness
      // within the ordinary Local startup window, not an artificial 10s sub-budget.
      await vi.waitFor(async () => expect((await readDiscovery(home))?.pid).toBe(pid), {
        timeout: 20_000,
      });
      phase("attach-fresh");
      const fresh = await attachLocalServer(home);
      expect(fresh.identity.pid).toBe(pid);
      fresh.close();
      phase("fresh-closed");
    } catch (error) {
      phase("primary-failure");
      await diagnose("cancellation.primary", error);
      throw error;
    } finally {
      phase("cleanup-release");
      abort.abort();
      if (bridge?.exitCode === null) bridge.kill();
      await writeFile(gate, "release");
      if (await readFile(marker, "utf8").catch(() => null))
        await vi.waitFor(async () => expect(await readDiscovery(home)).not.toBeNull(), {
          timeout: 10_000,
        });
      phase("cleanup-stop");
      await stopHome(home);
      phase("cleanup-remove");
      await rm(home, { recursive: true, force: true });
      phase("complete");
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

function backgroundPhases(home: string) {
  const started = performance.now();
  const phases: { phase: string; ms: number }[] = [];
  const phase = (phase: string) => phases.push({ phase, ms: performance.now() - started });
  const describe = (error: unknown) =>
    error instanceof Error ? { name: error.name, message: error.message } : { type: typeof error };
  const report = async (event: string, error?: unknown) => {
    const observedPhases = phases.slice();
    const child = await open(join(home, ".server", "startup.log"), "r")
      .then(async (log) => {
        try {
          const { size } = await log.stat();
          const bytes = Buffer.alloc(Math.min(size, 16_384));
          const { bytesRead } = await log.read(bytes, 0, bytes.length, size - bytes.length);
          return bytes.subarray(0, bytesRead).toString("utf8");
        } finally {
          await log.close();
        }
      })
      .catch((error: unknown) => ({ readError: describe(error) }));
    console.error(
      JSON.stringify({
        event,
        phases: observedPhases,
        child,
        ...(error === undefined ? {} : { error: describe(error) }),
      }),
    );
  };
  onTestFailed(() => report("background.diagnostic"));
  return { phase, failure: (error: unknown) => report("background.primary", error) };
}

it("converges simultaneous starters and rejects unauthenticated peers", async () => {
  const home = join(tmpdir(), `harness-background-${randomUUID()}`);
  const { phase, failure } = backgroundPhases(home);
  const hosts: Awaited<ReturnType<typeof ensureLocalServer>>[] = [];
  let unauthorized: ReturnType<typeof createConnection> | undefined;
  try {
    phase("launch-starters");
    const results = await Promise.allSettled([
      ensureLocalServer(home, launch),
      ensureLocalServer(home, launch),
    ]);
    for (const result of results) if (result.status === "fulfilled") hosts.push(result.value);
    const first = results[0];
    const second = results[1];
    if (first.status === "rejected") throw first.reason;
    if (second.status === "rejected") throw second.reason;
    expect(second.value.identity).toEqual(first.value.identity);
    phase("reject-unauthenticated");
    const discovery = await readDiscovery(home);
    if (discovery === null) throw new Error("Missing discovery");
    unauthorized = createConnection({ host: "127.0.0.1", port: discovery.port });
    await once(unauthorized, "connect");
    unauthorized.write("wrong-token\n");
    await once(unauthorized, "close");
  } catch (error) {
    await failure(error);
    throw error;
  } finally {
    phase("cleanup-stop");
    unauthorized?.destroy();
    for (const host of hosts) host.close();
    await stopHome(home);
    phase("cleanup-remove");
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it("retires discovery on Local Stop and preserves server identity after restart", async () => {
  const home = join(tmpdir(), `harness-background-restart-${randomUUID()}`);
  const { phase, failure } = backgroundPhases(home);
  let first: Awaited<ReturnType<typeof ensureLocalServer>> | undefined;
  let restarted: Awaited<ReturnType<typeof ensureLocalServer>> | undefined;
  try {
    phase("launch-owner");
    first = await ensureLocalServer(home, launch);
    first.close();
    phase("stop-owner");
    await stopHome(home);
    expect(await readDiscovery(home)).toBeNull();
    phase("restart-owner");
    restarted = await ensureLocalServer(home, launch);
    expect(restarted.identity.serverId).toBe(first.identity.serverId);
    expect(restarted.identity.instanceId).not.toBe(first.identity.instanceId);
  } catch (error) {
    await failure(error);
    throw error;
  } finally {
    phase("cleanup-stop");
    first?.close();
    restarted?.close();
    await stopHome(home);
    phase("cleanup-remove");
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

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

it("preserves a pending conversation after its last observers and bridge parent exit", async () => {
  const home = join(tmpdir(), `harness-background-parent-${randomUUID()}`);
  const { phase, failure } = backgroundPhases(home);
  phase("launch-bridge-owner");
  const bridge = spawn(process.execPath, [...args, "--bridge"], {
    env: { ...process.env, HARNESS_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostics = "";
  bridge.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const exited = once(bridge, "close");
  const client = new HarnessClient({
    connection: createNdjsonMessageConnection(bridge.stdout, bridge.stdin),
    client: { name: "parent-exit-test", version: "1" },
    plugins: [{ id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION }],
  });
  let first: Awaited<ReturnType<typeof attachLocalServer>> | undefined;
  let fresh: Awaited<ReturnType<typeof attachLocalServer>> | undefined;
  let reconnect: HarnessClient | undefined;
  try {
    await client.start();
    const identity = await client.peer.request(serverInfoRequest, {});
    phase("attach-observer");
    first = await attachLocalServer(home);
    expect(first.identity).toEqual(identity);
    const approvals = new ApprovalClient(client);
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
    phase("await-approval");
    await client.deliver(conversation.id, "survive the last client", "send");
    await pending;
    phase("leave-last-observers");
    first.close();
    client.closeConnection();
    const result: unknown[] = await exited;
    expect(diagnostics).toBe("");
    expect(result[0]).toBe(0);
    phase("reattach-owner");
    fresh = await attachLocalServer(home);
    expect(fresh.identity).toEqual(identity);
    reconnect = new HarnessClient({
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
    phase("complete-restored-turn");
    await restored.respond(restoredId!, "allow");
    expect(await completed).toBe("completed");
    phase("verify-history");
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
  } catch (error) {
    await failure(error);
    throw error;
  } finally {
    phase("cleanup-bridge");
    first?.close();
    reconnect?.closeConnection();
    fresh?.close();
    client.closeConnection();
    if (bridge.exitCode === null) bridge.kill();
    await exited;
    phase("cleanup-stop");
    await stopHome(home);
    phase("cleanup-remove");
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

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

it("recovers stale discovery with an active reader after a crash and canonicalizes home routes", async () => {
  const home = join(tmpdir(), `harness-background-crash-${randomUUID()}`);
  let staleDiscovery: FileHandle | undefined;
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
    staleDiscovery = await open(join(home, ".server", "discovery.json"), "r");
    const replacement = await ensureLocalServer(join(home, "."), launch).catch(
      async (error: unknown) => {
        throw new Error(await readFile(join(home, ".server", "startup.log"), "utf8"), {
          cause: error,
        });
      },
    );
    expect(replacement.identity.serverId).toBe(first.identity.serverId);
    expect(replacement.identity.instanceId).not.toBe(first.identity.instanceId);
    expect(JSON.parse(await staleDiscovery.readFile("utf8"))).toMatchObject({
      instanceId: first.identity.instanceId,
    });
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
    await staleDiscovery?.close();
    await stopHome(home);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
