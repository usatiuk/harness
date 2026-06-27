import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { runCommand, type CommandContext } from "./commands.ts";

const makeCtx = (over: Partial<CommandContext> = {}): CommandContext => ({
  service: {} as unknown as HarnessService,
  conversationId: "c1" as ConversationId,
  cwd: "/work",
  model: { provider: "openai", model: "gpt-5.1" },
  note: vi.fn(),
  clear: vi.fn(),
  resume: vi.fn(),
  pickModel: vi.fn(),
  pickEffort: vi.fn(),
  showActivities: vi.fn(),
  showSandbox: vi.fn(),
  sandbox: {
    enabled: false,
    active: false,
    phase: undefined,
    setEnabled: vi.fn(),
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

  it("/help writes a note listing the commands", () => {
    const ctx = makeCtx();
    runCommand("/help", ctx);
    expect(ctx.note).toHaveBeenCalledOnce();
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

  it("/sandbox on|off|rebuild|stop dispatch to the view", () => {
    const ctx = makeCtx();
    runCommand("/sandbox on", ctx);
    expect(ctx.sandbox.setEnabled).toHaveBeenCalledWith(true);
    runCommand("/sandbox off", ctx);
    expect(ctx.sandbox.setEnabled).toHaveBeenCalledWith(false);
    runCommand("/sandbox rebuild", ctx);
    expect(ctx.sandbox.rebuild).toHaveBeenCalledOnce();
    runCommand("/sandbox stop", ctx);
    expect(ctx.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("/sandbox with an unknown action notes an error", () => {
    const ctx = makeCtx();
    runCommand("/sandbox bogus", ctx);
    expect(ctx.note).toHaveBeenCalledWith("unknown sandbox action: bogus (on|off|rebuild|stop)");
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

  const withEfforts = (setModel = vi.fn().mockResolvedValue(undefined)): HarnessService =>
    ({
      availableModels: () => [
        { provider: "openai", model: "gpt-5.1", efforts: [{ value: "low" }, { value: "high" }] },
      ],
      setModel,
    }) as unknown as HarnessService;

  it("/effort with no args opens the picker", () => {
    const ctx = makeCtx({ service: withEfforts() });
    runCommand("/effort", ctx);
    expect(ctx.pickEffort).toHaveBeenCalledOnce();
  });

  it("/effort <value> switches when the current model offers it", async () => {
    const setModel = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ service: withEfforts(setModel) });
    runCommand("/effort high", ctx);
    expect(setModel).toHaveBeenCalledWith("c1", {
      provider: "openai",
      model: "gpt-5.1",
      effort: "high",
    });
    await Promise.resolve();
    expect(ctx.note).toHaveBeenCalledWith("effort → openai/gpt-5.1/high");
  });

  it("/effort <value> notes an error for an unoffered effort and never switches", () => {
    const setModel = vi.fn();
    const ctx = makeCtx({ service: withEfforts(setModel) });
    runCommand("/effort bogus", ctx);
    expect(setModel).not.toHaveBeenCalled();
    expect(ctx.note).toHaveBeenCalledWith("unknown effort: bogus (try: low, high)");
  });

  it("/effort notes when the current model has no effort axis", () => {
    const service = {
      availableModels: () => [{ provider: "openai", model: "gpt-5.1" }],
      setModel: vi.fn(),
    } as unknown as HarnessService;
    const ctx = makeCtx({ service });
    runCommand("/effort", ctx);
    expect(ctx.pickEffort).not.toHaveBeenCalled();
    expect(ctx.note).toHaveBeenCalledWith("gpt-5.1 has no effort options");
  });
});
