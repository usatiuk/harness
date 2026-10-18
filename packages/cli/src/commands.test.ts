import { testPlugins } from "./test-plugins.ts";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { runCommand, type CommandContext } from "./commands.ts";

const makeCtx = (over: Partial<CommandContext> = {}): CommandContext => ({
  service: {} as unknown as HarnessService,
  conversationId: "c1" as ConversationId,
  plugins: testPlugins(),
  cwd: "/work",
  model: { provider: "openai", model: "gpt-5.1" },
  config: {
    instructions: "",
    model: { provider: "openai", model: "gpt-5.1" },
    plugins: {},
  },
  note: vi.fn(),
  clear: vi.fn(),
  resume: vi.fn(),
  reload: vi.fn(),
  pickModel: vi.fn(),
  pickPreset: vi.fn(),
  fork: vi.fn(),
  showActivities: vi.fn(),
  showQuestions: vi.fn(),
  showSandbox: vi.fn(),
  sandbox: {
    backend: "none",
    workspaceWrite: true,
    network: true,
    containerActive: false,
    phase: undefined,
    setBackend: vi.fn(),
    setWorkspaceWrite: vi.fn(),
    setNetwork: vi.fn(),
    rebuild: vi.fn(),
    stop: vi.fn(),
  },
  exit: vi.fn(),
  ...over,
});

describe("runCommand", () => {
  it("dispatches a known command and reports success", () => {
    const ctx = makeCtx();
    expect(runCommand("/clear", ctx)).toBe(true);
    expect(ctx.clear).toHaveBeenCalledOnce();
  });

  it("returns false for an unknown command", () => {
    expect(runCommand("/nope", makeCtx())).toBe(false);
  });

  it("/reload asks the session owner to reactivate the current conversation", () => {
    const ctx = makeCtx();
    expect(runCommand("/reload", ctx)).toBe(true);
    expect(ctx.reload).toHaveBeenCalledOnce();
  });

  it("/help writes a note listing the commands", () => {
    const ctx = makeCtx();
    runCommand("/help", ctx);
    expect(ctx.note).toHaveBeenCalledOnce();
  });

  it("/compact runs a summary-only service operation", async () => {
    const compact = vi.fn(async () => "compacted" as const);
    const ctx = makeCtx({ service: { compact } as unknown as HarnessService });
    expect(runCommand("/compact", ctx)).toBe(true);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledWith(ctx.conversationId));
    expect(ctx.note).toHaveBeenCalledWith("context compacted");
  });

  it("/compact reports the underlying connection cause", async () => {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const failure = Object.assign(new Error("Connection error.", { cause: socket }), {
      name: "APIConnectionError",
    });
    const compact = vi.fn().mockRejectedValue(failure);
    const ctx = makeCtx({ service: { compact } as unknown as HarnessService });

    runCommand("/compact", ctx);

    await vi.waitFor(() =>
      expect(ctx.note).toHaveBeenCalledWith(
        "compaction failed: APIConnectionError: Connection error.\n" +
          "Caused by: Error: other side closed [UND_ERR_SOCKET]",
      ),
    );
  });

  it("/activities opens the activities overlay", () => {
    const ctx = makeCtx();
    expect(runCommand("/activities", ctx)).toBe(true);
    expect(ctx.showActivities).toHaveBeenCalledOnce();
  });

  it("/sandbox with no args opens the overlay", () => {
    const ctx = makeCtx();
    expect(runCommand("/sandbox", ctx)).toBe(true);
    expect(ctx.showSandbox).toHaveBeenCalledOnce();
  });

  it("/sandbox backend, policy, and lifecycle actions dispatch to the view", () => {
    const ctx = makeCtx();
    runCommand("/sandbox none", ctx);
    expect(ctx.sandbox.setBackend).toHaveBeenCalledWith("none");
    runCommand("/sandbox native", ctx);
    expect(ctx.sandbox.setBackend).toHaveBeenCalledWith("native");
    runCommand("/sandbox write off", ctx);
    expect(ctx.sandbox.setWorkspaceWrite).toHaveBeenCalledWith(false);
    runCommand("/sandbox network on", ctx);
    expect(ctx.sandbox.setNetwork).toHaveBeenCalledWith(true);
    runCommand("/sandbox rebuild", ctx);
    expect(ctx.sandbox.rebuild).toHaveBeenCalledOnce();
    runCommand("/sandbox stop", ctx);
    expect(ctx.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("/sandbox with an unknown action notes an error", () => {
    const ctx = makeCtx();
    runCommand("/sandbox bogus", ctx);
    expect(ctx.note).toHaveBeenCalledWith(
      "unknown sandbox action: bogus (none|native|docker|write|network|rebuild|stop)",
    );
  });

  it("/exit quits", () => {
    const ctx = makeCtx();
    runCommand("/exit", ctx);
    expect(ctx.exit).toHaveBeenCalledOnce();
  });

  it("/resume passes an id through, or undefined to open the picker", () => {
    const withId = makeCtx();
    runCommand("/resume abc123", withId);
    expect(withId.resume).toHaveBeenCalledWith("abc123");

    const noId = makeCtx();
    runCommand("/resume", noId);
    expect(noId.resume).toHaveBeenCalledWith(undefined);
  });

  it("/model with no args opens the picker", () => {
    const ctx = makeCtx();
    runCommand("/model", ctx);
    expect(ctx.pickModel).toHaveBeenCalledOnce();
  });

  it("/model <id> resolves the id against the catalog and switches", async () => {
    const setModel = vi.fn().mockResolvedValue(undefined);
    const service = {
      availableModels: () => [{ provider: "openai", model: "gpt-5.1" }],
      setModel,
    } as unknown as HarnessService;
    const ctx = makeCtx({ service });
    runCommand("/model gpt-5.1", ctx);
    expect(setModel).toHaveBeenCalledWith("c1", { provider: "openai", model: "gpt-5.1" });
    await Promise.resolve();
    expect(ctx.note).toHaveBeenCalledWith("model → openai/gpt-5.1");
  });

  it("/model <id> notes an error for an unknown model and never switches", () => {
    const setModel = vi.fn();
    const service = {
      availableModels: () => [{ provider: "openai", model: "gpt-5.1" }],
      setModel,
    } as unknown as HarnessService;
    const ctx = makeCtx({ service });
    runCommand("/model bogus", ctx);
    expect(setModel).not.toHaveBeenCalled();
    expect(ctx.note).toHaveBeenCalledWith("unknown model: bogus");
  });

  const withPresets = (setPreset = vi.fn().mockResolvedValue(undefined)): HarnessService =>
    ({
      availableModels: () => [
        {
          provider: "openai",
          model: "gpt-5.1",
          presets: [
            { value: "low" },
            { value: "high" },
            { value: "default" },
            { value: "--default" },
          ],
        },
      ],
      setPreset,
    }) as unknown as HarnessService;

  it("/preset with no args opens the picker", () => {
    const ctx = makeCtx({ service: withPresets() });
    runCommand("/preset", ctx);
    expect(ctx.pickPreset).toHaveBeenCalledOnce();
  });

  it("/preset <value> switches when the current model offers it", async () => {
    const setPreset = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ service: withPresets(setPreset) });
    runCommand("/preset high", ctx);
    expect(setPreset).toHaveBeenCalledWith("c1", ctx.model, "high");
    await Promise.resolve();
    expect(ctx.note).toHaveBeenCalledWith("preset → openai/gpt-5.1/high");
  });

  it("keeps provider-opaque default-like preset names selectable", async () => {
    const setPreset = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ service: withPresets(setPreset) });

    runCommand("/preset default", ctx);
    expect(setPreset).toHaveBeenLastCalledWith("c1", ctx.model, "default");
    runCommand("/preset --default", ctx);
    expect(setPreset).toHaveBeenLastCalledWith("c1", ctx.model, "--default");
  });

  it("/preset-default clears the preset for the identity the user acted on", async () => {
    const setPreset = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ service: withPresets(setPreset) });
    runCommand("/preset-default", ctx);
    expect(setPreset).toHaveBeenCalledWith("c1", ctx.model, undefined);
  });

  it("/preset <value> notes an error for an unoffered preset and never switches", () => {
    const setPreset = vi.fn();
    const ctx = makeCtx({ service: withPresets(setPreset) });
    runCommand("/preset bogus", ctx);
    expect(setPreset).not.toHaveBeenCalled();
    expect(ctx.note).toHaveBeenCalledWith(
      "unknown preset: bogus (try: low, high, default, --default)",
    );
  });

  it("/preset notes when the current model has no preset axis", () => {
    const service = {
      availableModels: () => [{ provider: "openai", model: "gpt-5.1" }],
      setPreset: vi.fn(),
    } as unknown as HarnessService;
    const ctx = makeCtx({ service });
    runCommand("/preset", ctx);
    expect(ctx.pickPreset).not.toHaveBeenCalled();
    expect(ctx.note).toHaveBeenCalledWith("gpt-5.1 has no preset options");
  });

  it("/auto-approve reports status without changing config", () => {
    const setPluginConfig = vi.fn();
    const service = { setPluginConfig } as unknown as HarnessService;
    const ctx = makeCtx({ service });
    runCommand("/auto-approve", ctx);
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(ctx.note).toHaveBeenCalledWith(
      "auto-approval off · reviewer openai/gpt-5.1 (turn model)",
    );
  });

  it("/auto-approve labels a configured reviewer without claiming config provenance", () => {
    const ctx = makeCtx({
      config: {
        instructions: "",
        model: { provider: "openai", model: "gpt-5.1" },
        plugins: {
          "auto-approval": {
            enabled: true,
            model: { provider: "anthropic", model: "claude-reviewer" },
          },
        },
      },
    });
    runCommand("/auto-approve", ctx);
    expect(ctx.note).toHaveBeenCalledWith(
      "auto-approval on · reviewer anthropic/claude-reviewer (configured reviewer)",
    );
  });

  it("/auto-approve on persists the conversation override and global default", async () => {
    const setPluginConfig = vi.fn().mockResolvedValue(undefined);
    const service = { setPluginConfig } as unknown as HarnessService;
    const ctx = makeCtx({ service });
    runCommand("/auto-approve on", ctx);
    expect(setPluginConfig).toHaveBeenCalledWith(
      "c1",
      "auto-approval",
      { enabled: true },
      { saveGlobal: true },
    );
    await Promise.resolve();
    expect(ctx.note).toHaveBeenCalledWith("auto-approval → on");
  });

  it("/auto-approve rejects model-setting or unknown arguments", () => {
    const setPluginConfig = vi.fn();
    const ctx = makeCtx({ service: { setPluginConfig } as unknown as HarnessService });
    runCommand("/auto-approve openai/reviewer", ctx);
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(ctx.note).toHaveBeenCalledWith("usage: /auto-approve [on|off]");
  });
});

it("switches, pages and explicitly force-deletes worktrees through client plugins", async () => {
  const switchWorkspace = vi.fn().mockResolvedValue(undefined);
  const removeWorktree = vi.fn().mockResolvedValue(undefined);
  const managedWorktrees = vi.fn().mockResolvedValue([]);
  const ctx = makeCtx({
    plugins: testPlugins({ switchWorkspace, removeWorktree, managedWorktrees }),
  });
  runCommand("/worktree use /a path/worktree", ctx);
  await vi.waitFor(() => expect(ctx.note).toHaveBeenCalledWith("workspace switched"));
  expect(switchWorkspace).toHaveBeenCalledWith("c1", {
    kind: "existing",
    path: "/a path/worktree",
  });
  runCommand("/worktree delete /a path/worktree", ctx);
  await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledWith("/a path/worktree", false));
  runCommand("/worktree delete --force /a path/worktree", ctx);
  await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledWith("/a path/worktree", true));
  runCommand("/worktree managed /last path", ctx);
  await vi.waitFor(() => expect(managedWorktrees).toHaveBeenCalledWith(20, "/last path"));
});
it("reports refused worktree switches and manages Docker without direct process access", async () => {
  const controlDockerEnvironment = vi.fn().mockResolvedValue(undefined);
  const ctx = makeCtx({
    plugins: testPlugins({
      switchWorkspace: async () => {
        throw new Error("Stop background work");
      },
      controlDockerEnvironment,
    }),
  });
  runCommand("/worktree new", ctx);
  await vi.waitFor(() =>
    expect(ctx.note).toHaveBeenCalledWith("worktree: Error: Stop background work"),
  );
  runCommand("/docker stop environment", ctx);
  await vi.waitFor(() =>
    expect(controlDockerEnvironment).toHaveBeenCalledWith("environment", "stop"),
  );
  runCommand("/docker remove environment", ctx);
  await vi.waitFor(() =>
    expect(controlDockerEnvironment).toHaveBeenCalledWith("environment", "remove"),
  );
});
