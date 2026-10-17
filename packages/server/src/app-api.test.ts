import { unusedCodeEvaluator } from "@harness/testkit";
import { MemorySecretStore } from "@harness/secrets";
import * as credentials from "./credential-store.ts";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { buildServerHarness, buildServerComposition } from "./index.ts";
import {
  appSettingsRequest,
  appProviderCreateRequest,
  appAuthLoginRequest,
  appProvidersRequest,
  appSettingsUpdateRequest,
  appConversationListRequest,
  appConversationProjectsRequest,
} from "./client-protocol.ts";
import { readGlobalSettings, updateGlobalSettings } from "@harness/config";

it("normalizes legacy application tool mode while rejecting unsupported values", () => {
  expect(appSettingsUpdateRequest.params.parse({ toolMode: "direct" })).toEqual({
    toolMode: "hybrid",
  });
  expect(() => appSettingsUpdateRequest.params.parse({ toolMode: "invalid" })).toThrow();
});

it("offers all Harness capability tools upfront in both modes", async () => {
  const { DemoProvider } = await import("./demo-provider.ts");
  const { textStep } = await import("@harness/testkit");
  const home = await mkdtemp(join(tmpdir(), "harness-eager-roster-"));
  vi.stubEnv("HARNESS_HOME", home);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
    vi.stubEnv(key, "");
  const stream = vi.spyOn(DemoProvider.prototype, "stream").mockImplementation(async function* () {
    yield* textStep("done");
  });
  const agentRequests = () =>
    stream.mock.calls
      .map(([request]) => request)
      .filter((request) => request.tools?.some((tool) => tool.name === "eval"));
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  try {
    for (const mode of ["hybrid", "code-only"] as const) {
      const conversation = await harness.service.createConversation({
        overrides: { model: { provider: "demo", model: "demo-1" }, tools: { mode } },
      });
      await harness.service.send(conversation.id, "hello");
      await harness.service.whenIdle(conversation.id);
      const tools = agentRequests().at(-1)!.tools!;
      const upfront = [
        "activity_kill",
        "activity_list",
        "activity_peek",
        "activity_wait",
        "subagent",
        "worktree_list",
        "worktree_switch",
      ];
      for (const name of upfront) {
        if (mode === "hybrid") expect(tools.map((tool) => tool.name)).toContain(name);
        else {
          expect(tools.map((tool) => tool.name)).not.toContain(name);
          expect(tools.find((tool) => tool.name === "eval")!.description).toContain(
            `"name":"${name}"`,
          );
        }
      }
    }
    expect(agentRequests()).toHaveLength(2);
  } finally {
    await harness.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("creates a LiteLLM provider through RPC without storing its key in settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-provider-create-"));
  vi.stubEnv("HARNESS_HOME", home);
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENCODE_API_KEY",
    "MISTRAL_API_KEY",
    "MISTRAL_VIBE_API_KEY",
  ])
    vi.stubEnv(name, "");
  const store = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({ store, kind: "file" });
  vi.spyOn(credentials, "credentialStoreForLogin").mockResolvedValue({ store, kind: "file" });
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "setup-test", version: "1" },
  });
  const selection = {
    id: "work-gateway",
    label: "Work LiteLLM",
    type: "litellm",
    config: { baseUrl: "https://gateway.example.com", apiKey: { stored: true } },
  };
  try {
    await client.start();
    await expect(
      client.peer.request(appProviderCreateRequest, {
        ...selection,
        config: { baseUrl: "file:///invalid" },
      }),
    ).rejects.toThrow();
    expect((await readGlobalSettings(home)).providers).toBeUndefined();
    await expect(client.peer.request(appProviderCreateRequest, selection)).resolves.toEqual({
      restartRequired: true,
    });
    await expect(client.peer.request(appProviderCreateRequest, selection)).rejects.toThrow(
      "already exists",
    );
    await client.peer.request(appAuthLoginRequest, {
      provider: selection.id,
      key: "fixture-private",
      flow: "browser",
    });
    const saved = await readGlobalSettings(home);
    expect(saved.providers?.[selection.id]).toEqual({
      type: "litellm",
      label: selection.label,
      config: selection.config,
    });
    expect(JSON.stringify(saved)).not.toContain("fixture-private");
    expect(
      (await client.peer.request(appProvidersRequest, {})).find(
        (provider) => provider.id === selection.id,
      ),
    ).toMatchObject({ label: selection.label, authenticated: true, registered: false });
    expect(await store.get("provider-instance:work-gateway:api-key")).toBe("fixture-private");
  } finally {
    client.closeConnection();
    await harness.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

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
    expect(before.settings.toolMode).toBe("hybrid");
    expect(before.settings.showToolNames).toBe(true);
    const loaded = await client.create({});
    await client.attach(loaded.id);
    let loadedValue = true;
    for (const showToolNames of [false, true]) {
      await client.peer.request(appSettingsUpdateRequest, { showToolNames });
      expect((await client.attach(loaded.id)).root.config.tools?.showNames).toBe(loadedValue);
      expect(await client.reload(loaded.id)).toMatchObject({
        status: "reloaded",
        attachment: { root: { config: { tools: { showNames: showToolNames } } } },
      });
      loadedValue = showToolNames;
      expect((await client.peer.request(appSettingsRequest, {})).settings.showToolNames).toBe(
        showToolNames,
      );
      expect((await readGlobalSettings(home)).tools).toEqual({
        allow: ["read_file"],
        showNames: showToolNames,
      });
      expect((await client.create({})).config.tools?.showNames).toBe(showToolNames);
    }
    expect((await client.create({})).config.tools?.mode).toBe("hybrid");
    await client.peer.request(appSettingsUpdateRequest, { compactionThresholdTokens: 1200 });
    expect(
      (await client.peer.request(appSettingsRequest, {})).settings.compactionThresholdTokens,
    ).toBe(1200);
    expect((await readGlobalSettings(home)).compaction).toEqual({ thresholdTokens: 1200 });
    expect((await client.create({})).config.compaction).toEqual({ thresholdTokens: 1200 });
    await client.peer.request(appSettingsUpdateRequest, { compactionThresholdTokens: null });
    expect((await readGlobalSettings(home)).compaction).toBeUndefined();
    expect((await client.create({})).config.compaction).toBeNull();
    expect((await client.peer.request(appSettingsRequest, {})).settings).toEqual(before.settings);
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
      showNames: true,
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
      showNames: true,
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

it("pages recent root chats and every folder through RPC, preserving loaded counts on refresh", async () => {
  const { HarnessService, HarnessRpcHost, HarnessRpcSession } = await import("@harness/service");
  const { InMemoryStore } = await import("@harness/store");
  const { FakeProvider, counterIdGenerator, fixedClock, textStep } =
    await import("@harness/testkit");
  const { sandboxPlugin } = await import("@harness/sandbox");
  const { DesktopSession } = await import("../../desktop/src/session.ts");
  const { registerAppApi } = await import("./app-api.ts");
  const home = await realpath(await mkdtemp(join(tmpdir(), "harness-sidebar-rpc-")));
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const provider = new FakeProvider([textStep("done")]);
  vi.spyOn(provider, "listModels").mockReturnValue([{ provider: "fake", model: "fake-1" }]);
  const service = new HarnessService({
    codeEvaluator: unusedCodeEvaluator,
    store,
    home,
    defaults: { model: { provider: "fake", model: "fake-1" } },
    plugins: [{ id: "fake", providers: () => [provider] }, sandboxPlugin],
  });
  const host = new HarnessRpcHost(service);
  const pair = createInProcessMessageConnectionPair();
  const server = new HarnessRpcSession({
    host,
    connection: pair.right,
    server: { name: "test", version: "1" },
  });
  const api = registerAppApi(server, service, {
    signingIn: false,
    settingsTail: Promise.resolve(),
    active: { kind: null, entries: new Map(), statuses: new Map() },
  });
  const desktop = new DesktopSession(pair.left);
  server.start();
  try {
    const folders = Array.from({ length: 66 }, (_, index) => join(home, `folder-${index}`));
    for (const folder of folders) await mkdir(folder);
    const roots: import("@harness/protocol").ConversationRecord[] = [];
    for (const workspaceRoot of folders)
      roots.push(await store.createConversation({ workspaceRoot, overrides: {} }));
    const worktrees: typeof roots = [];
    for (let index = 0; index < 6; index++) {
      const workspaceRoot = join(home, `worktree-${index}`);
      await mkdir(workspaceRoot);
      worktrees.push(
        await store.createConversation({
          workspaceRoot,
          originalWorkspaceRoot: folders[0]!,
          overrides: {},
        }),
      );
    }
    for (let index = 0; index < 120; index++) {
      const child = await store.createConversation({ workspaceRoot: folders[0]!, overrides: {} });
      await store.putPluginState("subagents", child.id, "spawn", { parent: roots[0]!.id });
    }
    const childOnly = await store.createConversation({
      workspaceRoot: join(home, "child-only"),
      overrides: {},
    });
    await store.putPluginState("subagents", childOnly.id, "spawn", { parent: roots[0]!.id });
    await desktop.start();
    await desktop.refreshSidebar();
    expect(desktop.recents.rows).toHaveLength(20);
    expect(
      desktop.recents.rows.every((row) =>
        [...roots, ...worktrees].some((root) => root.id === row.id),
      ),
    ).toBe(true);
    expect(desktop.projects.rows).toHaveLength(50);
    await desktop.loadProjects(true);
    expect(desktop.projects.rows).toHaveLength(66);
    expect(
      desktop.projects.rows.some((project) => project.workspaceRoot.includes("worktree-")),
    ).toBe(false);
    await desktop.loadProject(folders[0]!);
    expect(desktop.projectPages.get(folders[0]!)?.rows.map((row) => row.id)).toEqual(
      worktrees
        .slice(1)
        .reverse()
        .map((row) => row.id),
    );
    await desktop.loadProject(folders[0]!, true);
    expect(desktop.projectPages.get(folders[0]!)?.rows.map((row) => row.id)).toEqual(
      [...worktrees]
        .reverse()
        .map((row) => row.id)
        .concat(roots[0]!.id),
    );
    expect(desktop.projects.rows.some((row) => row.workspaceRoot.endsWith("child-only"))).toBe(
      false,
    );
    await desktop.list(true);
    await desktop.list(true);
    expect(desktop.recents.rows).toHaveLength(60);
    const old = roots[0]!;
    const filtered = await desktop.client.peer.request(appConversationListRequest, {
      limit: 5,
      cursor: null,
      order: "lastUsed",
      filter: { workspaceRoot: folders[0]! },
    });
    expect(filtered.conversations.map((row) => row.id)).toEqual([old.id]);
    await desktop.load(old.id);
    await desktop.client.deliver(old.id, "hello", "send");
    await service.whenIdle(old.id);
    await desktop.refreshSidebar();
    expect(desktop.recents.rows[0]?.id).toBe(old.id);
    expect(desktop.recents.rows).toHaveLength(60);
    expect(desktop.projects.rows).toHaveLength(66);
    expect(desktop.projects.rows[0]?.workspaceRoot).toBe(folders[0]);
    const unchanged = (await desktop.client.get(old.id))!.lastUsedAt;
    await desktop.client.deliver(old.id, "", "interrupt");
    expect((await desktop.client.get(old.id))!.lastUsedAt).toBe(unchanged);
    const page = await desktop.client.peer.request(appConversationProjectsRequest, {
      limit: 1,
      cursor: null,
    });
    expect(page.projects[0]?.workspaceRoot).toBe(folders[0]);
    const next = await desktop.client.peer.request(appConversationProjectsRequest, {
      limit: 100,
      cursor: page.nextCursor,
    });
    expect(next.projects).toHaveLength(65);
    const id = await desktop.create(folders[1]!, "fake\u0000fake-1", "local", "hybrid", "");
    expect(desktop.recents.rows[0]?.id).toBe(id);
    expect(desktop.projects.rows[0]?.workspaceRoot).toBe(folders[1]);
  } finally {
    desktop.client.closeConnection();
    await api.close();
    await server.shutdown();
    await host.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
