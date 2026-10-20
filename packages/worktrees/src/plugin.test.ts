import { expect, it, vi } from "vitest";
import type { ConversationId, ToolContext } from "@harness/protocol";
import { WorktreesDefinition } from "./plugin.ts";

function setup() {
  const definition = new WorktreesDefinition();
  const selectWorkspace = vi.fn(async () => ({}));
  definition.bind({ workspaceOptions: vi.fn(async () => ({})), selectWorkspace });
  const tool = definition.create().tools!(
    {
      contentTypes: ["text"],
      toolCalling: true,
      customToolInput: { supported: false, grammars: [] },
      preferredEditTool: "replace",
    },
    { service: () => undefined },
  ).find((tool) => tool.name === "worktree_switch")!;
  if (tool.input.kind !== "function") throw new Error("Expected function tool");
  return { tool, schema: tool.input.schema, selectWorkspace };
}

it.each([
  { kind: "original" },
  { kind: "new" },
  { kind: "new", branch: "feature/auth" },
  { kind: "existing", path: "/checkout" },
])("preserves valid workspace selection %j and deferred switching", async (selection) => {
  const { tool, schema, selectWorkspace } = setup();
  const parsed = schema.parse(selection);
  expect(parsed).toEqual(selection);
  const ctx: ToolContext = {
    conversationId: "conversation" as ConversationId,
    callId: "switch",
    signal: new AbortController().signal,
    service: () => undefined,
    emit: () => {},
    deliver: () => {},
  };
  const result = await tool.execute(parsed, ctx);
  expect(result.status).toBe("ok");
  expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith(
    ctx.conversationId,
    selection,
    true,
    ctx.signal,
  );
});

it.each([
  { kind: "existing" },
  { kind: "existing", path: "" },
  { kind: "original", branch: "feature/auth" },
  { kind: "original", path: "/checkout" },
  { kind: "new", path: "/checkout" },
  { kind: "existing", path: "/checkout", branch: "feature/auth" },
  { kind: "new", branch: "" },
  { kind: "new", unexpected: true },
  { kind: "invalid" },
  {},
])("rejects invalid workspace selection %j", (selection) => {
  expect(setup().schema.safeParse(selection).success).toBe(false);
});
