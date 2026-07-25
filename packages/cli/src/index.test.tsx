import { describe, expect, it, vi } from "vitest";
import type { Conversation, ConversationId } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { ACTIVITY_APPROVAL_DEFAULTS, loadSession } from "./index.tsx";

describe("CLI approval defaults", () => {
  it("allows controls for activities already owned by the conversation", () => {
    expect(ACTIVITY_APPROVAL_DEFAULTS).toEqual({
      activity_wait: "allow",
      activity_peek: "allow",
      activity_list: "allow",
      activity_kill: "allow",
    });
  });
});

describe("loadSession", () => {
  it("prepares the selected conversation before mounting its session", async () => {
    const conversation = {
      id: "c1" as ConversationId,
      workspaceRoot: "/work",
      config: { instructions: "", model: { provider: "demo", model: "demo-1" } },
      overrides: {},
      head: null,
      createdAt: 0,
    } as Conversation;
    const prepare = vi.fn().mockResolvedValue(undefined);
    const service = {
      getConversation: vi.fn().mockResolvedValue(conversation),
      getItems: vi.fn().mockResolvedValue([]),
      usage: vi.fn().mockResolvedValue([]),
      prepare,
    } as unknown as HarnessService;

    await expect(loadSession(service, "c1")).resolves.toEqual({
      conversation,
      items: [],
      usage: [],
    });
    expect(prepare).toHaveBeenCalledWith(conversation.id);
  });
});
