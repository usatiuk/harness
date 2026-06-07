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
});
