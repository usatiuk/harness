import { expect, it } from "vitest";
import { decodeModelInfo } from "@harness/client";
import type { ModelInfo, NewItem } from "@harness/protocol";
import { projectItem, projectModelInfo } from "./wire.ts";
import { InMemoryStore } from "@harness/store";

it("projects grouped items through the strict public history schema without group metadata", async () => {
  const store = new InMemoryStore();
  const conversation = await store.createConversation({ workspaceRoot: null, overrides: {} });
  const message: NewItem = {
    conversationId: conversation.id,
    turnId: null,
    type: "message",
    role: "system",
    content: [],
  };
  const [item] = await store.appendItems([[message, message]]);
  expect(projectItem(item!)).not.toHaveProperty("group");
});

it.each([true, false, undefined])(
  "preserves image-input metadata %s across the public model boundary",
  (supportsImages) => {
    const model: ModelInfo = {
      provider: "test",
      model: "test",
      ...(supportsImages === undefined ? {} : { supportsImages }),
    };
    const wire = projectModelInfo(model);
    expect(wire.supportsImages).toBe(supportsImages ?? null);
    expect(decodeModelInfo(wire)).toEqual(model);
  },
);
