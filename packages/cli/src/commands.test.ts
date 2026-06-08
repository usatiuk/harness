import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { runCommand, type CommandContext } from "./commands.ts";

const makeCtx = (over: Partial<CommandContext> = {}): CommandContext => ({
  service: {} as unknown as HarnessService,
  conversationId: "c1" as ConversationId,
  note: vi.fn(),
  clear: vi.fn(),
  resume: vi.fn(),
  pickModel: vi.fn(),
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
});
