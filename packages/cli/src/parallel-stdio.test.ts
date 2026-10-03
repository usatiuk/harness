import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { HarnessClient, type HarnessClientEvent } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import {
  APPROVAL_CLIENT_CONTRACT_VERSION,
  ApprovalClient,
  type ApprovalClientEvent,
  type ClientApproval,
} from "@harness/approval";
import type { ConversationId } from "@harness/protocol";
import { CLI_PLUGIN_CONTRACTS, CliPluginClient } from "./client-plugins.ts";

it("runs simultaneous roots and scoped approvals/processes over a real stdio server", async () => {
  const project = await mkdtemp(join(tmpdir(), "harness-parallel-stdio-"));
  const otherProject = join(project, "other");
  await mkdir(otherProject);
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--conditions=development",
      fileURLToPath(new URL("./parallel-stdio-fixture.ts", import.meta.url)),
    ],
    { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new HarnessClient({
    connection: createNdjsonMessageConnection(child.stdout, child.stdin),
    client: { name: "parallel-test", version: "1" },
    plugins: [
      { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
      ...CLI_PLUGIN_CONTRACTS,
    ],
  });
  const approvals = new ApprovalClient(client.peer);
  const plugins = new CliPluginClient(client, approvals);
  const events: HarnessClientEvent[] = [];
  client.subscribe((event) => events.push(event));
  const terminal = (id: string) =>
    new Promise<void>((resolve) => {
      const unsubscribe = client.subscribe((event) => {
        if (
          event.type === "conversation" &&
          event.conversationId === id &&
          event.event.type === "turn.changed" &&
          event.event.status === "completed"
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
  const approval = (id: string, observed: ApprovalClientEvent[]) =>
    new Promise<ClientApproval>((resolve) => {
      approvals.subscribe(id, (event) => {
        observed.push(event);
        if (event.type === "created") resolve(event.approval);
      });
    });
  try {
    await client.start();
    const a = await client.create({ cwd: project });
    const b = await client.create({ cwd: otherProject });
    await Promise.all([client.attach(a.id), client.attach(b.id)]);
    const aEvents: ApprovalClientEvent[] = [],
      bEvents: ApprovalClientEvent[] = [];
    const aApproval = approval(a.id, aEvents),
      bApproval = approval(b.id, bEvents);
    await Promise.all([
      client.deliver(a.id, "message-A", "send"),
      client.deliver(b.id, "message-B", "send"),
    ]);
    const [pendingA, pendingB] = await Promise.all([aApproval, bApproval]);
    expect(pendingA.requestId).not.toBe(pendingB.requestId);
    expect(pendingA.conversationId).toBe(a.id);
    expect(pendingB.conversationId).toBe(b.id);
    let ready!: () => void, shellDone!: () => void;
    const shellReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const shellExit = new Promise<void>((resolve) => {
      shellDone = resolve;
    });
    let output = "";
    const shell = plugins.runShell(
      b.id as ConversationId,
      process.platform === "win32"
        ? "Write-Output 'B-shell-ready'; Start-Sleep -Seconds 30"
        : "printf 'B-shell-ready\\n'; sleep 30",
      (_id, event) => {
        if (event.type === "data") {
          output += event.text;
          if (output.includes("B-shell-ready")) ready();
        } else shellDone();
      },
    );
    await shell.accepted;
    await shellReady;
    await client.close(a.id, true);
    expect(aEvents.filter((event) => event.type === "resolved")).toHaveLength(1);
    expect(bEvents.filter((event) => event.type === "resolved")).toHaveLength(0);
    expect(plugins.runningActivities(b.id as ConversationId)).toBe(1);
    const bDone = terminal(b.id);
    approvals.respond(pendingB.requestId, "allow");
    await bDone;
    expect(bEvents.filter((event) => event.type === "resolved")).toHaveLength(1);
    await plugins.activities(b.id as ConversationId).kill(shell.id);
    await shellExit;
    expect(output).toContain("B-shell-ready");
    await client.attach(a.id);
    const retryEvents: ApprovalClientEvent[] = [];
    const retryApproval = approval(a.id, retryEvents);
    const aDone = terminal(a.id);
    await client.deliver(a.id, "retry-A", "send");
    approvals.respond((await retryApproval).requestId, "allow");
    await aDone;
    const historyA = JSON.stringify((await client.history({ conversationId: a.id })).entries);
    const historyB = JSON.stringify((await client.history({ conversationId: b.id })).entries);
    expect(historyA).toContain("retry-A");
    expect(historyA).not.toContain("message-B");
    expect(historyB).toContain("message-B");
    expect(historyB).not.toContain("retry-A");
    expect(
      events.filter((event) => event.type === "detached").map((event) => event.rootConversationId),
    ).toEqual([a.id]);
    await client.close(a.id, true);
    await client.close(b.id, true);
    child.stdin.end();
    expect((await exit)[0], stderr).toBe(0);
  } finally {
    // EOF lets the fixture close all owned roots/processes before exiting, including on failure.
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill(), 5_000);
    try {
      await exit;
    } finally {
      clearTimeout(killTimer);
      client.peer.close();
    }
    await rm(project, { recursive: true, force: true });
  }
}, 20_000);
