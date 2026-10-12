import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { buildServerHarness, buildServerComposition } from "./index.ts";
import { appSettingsRequest, appSettingsUpdateRequest } from "./client-protocol.ts";
import { readGlobalSettings, updateGlobalSettings } from "@harness/config";

it("saves creation defaults without changing unrelated global settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-creation-defaults-"));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENCODE_API_KEY", "");
  await updateGlobalSettings(home, (doc) => ({
    ...doc,
    tools: { allow: ["read_file"] },
    plugins: { approval: { inWorkspace: "deny" } },
  }));
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "defaults-test", version: "1" },
  });
  try {
    await client.start();
    const before = await client.peer.request(appSettingsRequest, {});
    await client.peer.request(appSettingsUpdateRequest, {
      model: { provider: "demo", model: "demo-1", preset: "high" },
      sandbox: "docker",
      toolMode: "hybrid",
    });
    const saved = await client.peer.request(appSettingsRequest, {});
    expect(saved.settings).toEqual({
      ...before.settings,
      model: { provider: "demo", model: "demo-1", preset: "high" },
      sandbox: "docker",
      toolMode: "hybrid",
    });
    expect((await readGlobalSettings(home)).tools).toEqual({
      allow: ["read_file"],
      mode: "hybrid",
    });
    const created = await client.create({});
    expect(created.config).toMatchObject({
      model: { provider: "demo", model: "demo-1", preset: "high" },
      tools: { mode: "hybrid" },
      plugins: { sandbox: { backend: "docker" } },
    });
    await client.peer.request(appSettingsUpdateRequest, {
      model: { provider: "demo", model: "demo-1", preset: null },
    });
    expect((await readGlobalSettings(home)).model).toEqual({ provider: "demo", model: "demo-1" });
    expect((await readGlobalSettings(home)).tools).toEqual({
      allow: ["read_file"],
      mode: "hybrid",
    });
  } finally {
    client.closeConnection();
    await harness.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("logs the failed RPC method and error class without exception content", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-diagnostic-"));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENCODE_API_KEY", "");
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "diagnostic-test", version: "1" },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await client.start();
    const conversation = await client.create({ overrides: {} });
    const secretError = new TypeError("private provider exception content");
    secretError.name = "private exception name";
    vi.spyOn(harness.service, "prepare").mockRejectedValueOnce(secretError);
    await expect(client.attach(conversation.id)).rejects.toThrow();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "server.failure", method: "conversation.attach", kind: "TypeError" }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  } finally {
    client.closeConnection();
    await harness.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("drains an admitted settings refresh before closing the database", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-app-settings-close-"));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENCODE_API_KEY", "");
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "settings-close-test", version: "1" },
  });
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    await client.start();
    for (let count = 0; count < 2; count++) {
      const conversation = await client.create({ overrides: {} });
      await client.attach(conversation.id);
    }
    const getConversation = harness.store.getConversation.bind(harness.store);
    let first = true;
    vi.spyOn(harness.store, "getConversation").mockImplementation(async (id) => {
      if (first) {
        first = false;
        markEntered();
        await gate;
      }
      return getConversation(id);
    });
    let refreshed = false;
    const refresh = harness.service.refreshPluginDefaults.bind(harness.service);
    vi.spyOn(harness.service, "refreshPluginDefaults").mockImplementation(async (ids) => {
      await refresh(ids);
      refreshed = true;
    });
    let closedAfterRefresh = false;
    const closeStore = harness.store.close.bind(harness.store);
    vi.spyOn(harness.store, "close").mockImplementation(() => {
      closedAfterRefresh = refreshed;
      closeStore();
    });
    const updating = client.peer.request(appSettingsUpdateRequest, {
      model: { provider: "demo", model: "demo-1", preset: null },
      approval: { inWorkspace: "ask", outOfWorkspace: "ask", humanApprovalTimeoutSeconds: 60 },
      autoApproval: { enabled: false, model: null, timeoutSeconds: 30 },
      conversationTitleModel: null,
      sandbox: "local",
    });
    const outcome = updating.then(
      () => null,
      (error: unknown) => error,
    );
    await entered;
    const closing = harness.close();
    // Release the settings IO after shutdown has been requested. Both subsequent runtime
    // lookups must complete against an open database, not merely the first gated lookup.
    release();
    await closing;
    await outcome;
    expect(refreshed).toBe(true);
    expect(closedAfterRefresh).toBe(true);
  } finally {
    release();
    await harness.close();
    client.closeConnection();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("shares composition shutdown drainage and refuses new connections while stopping", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-shared-close-"));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENCODE_API_KEY", "");
  const composition = await buildServerComposition();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const operation = composition.host.request(() => gate);
    const closing = composition.close();
    expect(composition.close()).toBe(closing);
    const pair = createInProcessMessageConnectionPair();
    expect(() => composition.connect(pair.right)).toThrow("server is stopping");
    release();
    await operation;
    await closing;
    expect(() => composition.connect(pair.right)).toThrow("server is stopping");
  } finally {
    release();
    await composition.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
