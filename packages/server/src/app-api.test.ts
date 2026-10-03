import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { buildServerHarness, buildServerComposition } from "./index.ts";
import { appSettingsUpdateRequest } from "./client-protocol.ts";

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
      approval: { inWorkspace: "ask", outOfWorkspace: "ask" },
      autoApproval: { enabled: false, model: null },
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
