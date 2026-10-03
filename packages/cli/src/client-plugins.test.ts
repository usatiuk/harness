import { approvalDecideRequest } from "@harness/approval";
import { HarnessRpcHost } from "@harness/service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, PluginContract } from "@harness/protocol";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessRpcSession, HarnessService } from "@harness/service";
import { SqliteStore } from "@harness/store-sqlite";
import { activitiesPlugin } from "@harness/activities";
import { sandboxPlugin } from "@harness/sandbox";
import { workspaceShellRunRequest } from "@harness/workspace";
import {
  APPROVAL_CLIENT_CONTRACT_VERSION,
  ApprovalClient,
  approvalCreatedNotification,
} from "@harness/approval";
import {
  CLI_PLUGIN_CONTRACTS,
  CliPluginClient,
  registerCliPluginServer,
} from "./client-plugins.ts";

const homes: string[] = [];
const fixtures: Array<{ host: HarnessRpcHost; session: HarnessRpcSession; store: SqliteStore }> =
  [];
afterEach(async () => {
  for (const { host, session, store } of fixtures.splice(0)) {
    try {
      await host.shutdown();
    } finally {
      await session.shutdown();
      store.close();
    }
  }
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createHarness() {
  const home = await mkdtemp(join(tmpdir(), "harness-cli-plugin-test-"));
  homes.push(home);
  const errors: unknown[] = [];
  const store = new SqliteStore(":memory:");
  const service = new HarnessService({
    home,
    store,
    plugins: [sandboxPlugin, activitiesPlugin],
    defaults: { model: { provider: "demo", model: "demo-1" } },
  });
  const connections = createInProcessMessageConnectionPair();
  const contracts: PluginContract[] = [
    { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
    ...CLI_PLUGIN_CONTRACTS,
  ];
  const host = new HarnessRpcHost(service);
  const session = new HarnessRpcSession({
    connection: connections.right,
    host,
    server: { name: "test-server", version: "1" },
    plugins: contracts,
    onError: (error) => errors.push(error),
  });
  fixtures.push({ host, session, store });
  registerCliPluginServer(session, service);
  const client = new HarnessClient({
    connection: connections.left,
    client: { name: "test-client", version: "1" },
    plugins: contracts,
    onProtocolError: (error) => errors.push(error),
  });
  const approvals = new ApprovalClient(client);
  const plugins = new CliPluginClient(client, approvals);
  session.start();
  await client.start();
  const conversation = await client.create({
    cwd: process.cwd(),
    overrides: { instructions: "", model: { provider: "demo", model: "demo-1" } },
  });
  await client.attach(conversation.id);
  return { client, conversation, errors, plugins, service, session };
}

describe("CLI plugin protocol", () => {
  it("runs shell work on the server and streams output through typed plugin messages", async () => {
    const { conversation, errors, plugins, session } = await createHarness();
    const lifecycle: string[] = [];
    plugins.subscribe(conversation.id as ConversationId, (event) => {
      if (event.type === "activity.started" || event.type === "activity.exited") {
        lifecycle.push(event.type);
      }
    });
    const shellEvents: Array<{ type: string; text?: string; exitCode?: number }> = [];
    const run = plugins.runShell(
      conversation.id as ConversationId,
      "echo hello",
      (_shellId, event) => shellEvents.push(event),
    );
    await run.accepted;

    await vi.waitFor(
      () =>
        expect(shellEvents.at(-1), JSON.stringify(errors)).toEqual({
          type: "exited",
          exitCode: 0,
        }),
      { timeout: 10_000 },
    );
    expect(shellEvents.flatMap((event) => event.text ?? []).join("")).toContain("hello");
    await vi.waitFor(() => expect(lifecycle).toEqual(["activity.started", "activity.exited"]), {
      timeout: 10_000,
    });
    const content = await plugins.activities(conversation.id as ConversationId).peek(run.id);
    expect(content[0]?.text).toContain("hello");
    expect(await plugins.topLevel([conversation.id as ConversationId])).toEqual(
      new Set([conversation.id]),
    );
    await session.shutdown();
  });

  it("allocates shell ids across the connection rather than per mounted conversation", async () => {
    const { client, conversation, errors, plugins, session } = await createHarness();
    const second = await client.create({
      cwd: process.cwd(),
      overrides: { instructions: "", model: { provider: "demo", model: "demo-1" } },
    });
    await client.attach(second.id);
    const firstEvents: Array<{ type: string; text?: string }> = [];
    const secondEvents: Array<{ type: string; text?: string }> = [];
    const first = plugins.runShell(
      conversation.id as ConversationId,
      "node -e \"setTimeout(() => console.log('first-root'), 100)\"",
      (_shellId, event) => firstEvents.push(event),
    );
    const secondRun = plugins.runShell(
      second.id as ConversationId,
      "node -e \"console.log('second-root')\"",
      (_shellId, event) => secondEvents.push(event),
    );
    await Promise.all([first.accepted, secondRun.accepted]);
    expect(first.id).not.toBe(secondRun.id);

    await vi.waitFor(
      () => {
        expect(firstEvents.at(-1)?.type, JSON.stringify(errors)).toBe("exited");
        expect(secondEvents.at(-1)?.type, JSON.stringify(errors)).toBe("exited");
      },
      { timeout: 10_000 },
    );
    expect(firstEvents.flatMap((event) => event.text ?? []).join("")).toContain("first-root");
    expect(secondEvents.flatMap((event) => event.text ?? []).join("")).toContain("second-root");
    await session.shutdown();
  });

  it("rejects a duplicate active shell id at the server boundary", async () => {
    const { client, conversation, session } = await createHarness();
    const params = {
      conversationId: conversation.id,
      shellId: "duplicate-shell",
      command: 'node -e "setTimeout(() => {}, 1000)"',
    };
    await client.peer.request(workspaceShellRunRequest, params);
    await expect(client.peer.request(workspaceShellRunRequest, params)).rejects.toThrow(
      "internal error",
    );
    await session.shutdown();
  });

  it("persists sandbox configuration while attached before reloading the runtime", async () => {
    const { client, conversation, session } = await createHarness();

    await client.patchPluginConfig(
      conversation.id,
      "sandbox",
      { native: { workspaceWrite: false } },
      false,
    );
    await expect(client.close(conversation.id, false)).resolves.toEqual({ status: "closed" });
    const attachment = await client.attach(conversation.id);

    expect(attachment.root.config.plugins["sandbox"]).toMatchObject({
      native: { workspaceWrite: false },
    });
    await session.shutdown();
  });

  it("projects a server-owned approval and sends a decision", async () => {
    const { conversation, plugins, session } = await createHarness();
    session.onRequest(approvalDecideRequest, async ({ decision }) => {
      expect(decision).toBe("allow");
      return { resolved: true };
    });
    const seen: string[] = [];
    plugins.approvals.subscribe(conversation.id, (event) => seen.push(event.type));
    await session.notify(approvalCreatedNotification, {
      requestId: "approval-1",
      rootConversationId: conversation.id,
      conversationId: conversation.id,
      call: { callId: "call-1", name: "write_file", args: { path: "a.txt" } },
      relationship: "in-workspace",
    });
    await vi.waitFor(() => expect(seen).toEqual(["created"]));
    await plugins.approvals.respond("approval-1", "allow");
    expect(seen).toEqual(["created", "resolved"]);
    await session.shutdown();
  });
});
