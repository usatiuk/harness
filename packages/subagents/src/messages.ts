import { z } from "zod";
import {
  errorResult,
  okResult,
  type ConversationId,
  type ConversationRunner,
  type Tool,
  type ToolContext,
} from "@harness/protocol";
import {
  ancestorChain,
  rosterPage,
  isDismissed,
  conversationStatus,
  identity,
  relationship,
  spawnMark,
} from "./family.ts";

const cursor = z.strictObject({ createdAt: z.number(), id: z.string() });
const listArgs = z.strictObject({
  relation: z.enum(["parent", "siblings", "children"]),
  cursor: cursor.optional(),
});
const sendArgs = z.strictObject({ to: z.string(), message: z.string().trim().min(1) });

export class SubagentListTool implements Tool<z.infer<typeof listArgs>> {
  readonly essential = true;
  readonly name = "subagent_list";
  readonly description =
    "List your parent, siblings or children: conversation IDs, task names/slugs and status. Use the IDs with subagent_send. Results are paged; pass nextCursor to continue.";
  readonly input = { kind: "function" as const, schema: listArgs };
  constructor(private readonly runner: () => ConversationRunner) {}
  async execute({ relation, cursor }: z.infer<typeof listArgs>, ctx: ToolContext) {
    const runner = this.runner();
    const parent = (await spawnMark(runner, ctx.conversationId))?.parent.conversationId as
      ConversationId | undefined;
    const owner = relation === "children" ? ctx.conversationId : parent;
    const records =
      relation === "parent"
        ? parent
          ? [await identity(runner, parent)]
          : []
        : owner
          ? await rosterPage(runner, owner, 21, cursor)
          : [];
    const page = records.slice(0, 20);
    const agents = await Promise.all(
      page
        .filter((row) => row.id !== ctx.conversationId)
        .map(async (row) => ({
          ...(await identity(runner, row.id)),
          relation,
          status: await conversationStatus(runner, row.id),
        })),
    );
    const last = page.at(-1);
    const nextCursor =
      records.length > 20 && last && "createdAt" in last
        ? { createdAt: last.createdAt, id: last.id }
        : null;
    return {
      ...okResult(JSON.stringify({ agents, nextCursor })),
      structured: { agents, nextCursor },
    };
  }
}

export class SubagentSendTool implements Tool<z.infer<typeof sendArgs>> {
  readonly essential = true;
  readonly name = "subagent_send";
  readonly description =
    "Send a message to your parent, sibling or child using its conversation ID from subagent_list. Delivery joins its ordinary inbox and wakes it if idle, including after it finished. Returns acceptance, not a reply. Incoming subagent messages also wake your conversation if idle.";
  readonly input = { kind: "function" as const, schema: sendArgs };
  constructor(private readonly runner: () => ConversationRunner) {}
  async execute({ to, message }: z.infer<typeof sendArgs>, ctx: ToolContext) {
    const runner = this.runner();
    const target = to as ConversationId;
    const relation = await relationship(runner, ctx.conversationId, target);
    if (!relation) return errorResult("Recipient must be your parent, sibling or child.");
    if (relation !== "parent" && (await isDismissed(runner, target)))
      return errorResult(
        "Recipient has been dismissed. Sending to your direct parent is always allowed.",
      );
    const chain = await ancestorChain(runner, target);
    await runner.prepare(chain[0]!.id);
    for (let index = 1; index < chain.length; index++)
      runner.registerChild(chain[index - 1]!.id, chain[index]!.id);
    const sender = await identity(runner, ctx.conversationId);
    ctx.signal.throwIfAborted();
    await runner.deliver(
      target,
      {
        source: { kind: "plugin", pluginId: this.name },
        content: [
          {
            type: "text",
            text: `Message from ${sender.name} [${sender.slug}] (${sender.id}):\n${message}`,
          },
        ],
      },
      "steer",
    );
    return okResult(`Message accepted by ${to}.`);
  }
}

const dismissArgs = z.strictObject({ to: z.string() });
export class SubagentDismissTool implements Tool<z.infer<typeof dismissArgs>> {
  readonly essential = true;
  readonly name = "subagent_dismiss";
  readonly description =
    "Dismiss one of your direct children and its subtree from the active roster, freeing a child slot. They disappear from subagent_list and reject family messages, except messages to a direct parent. Existing activities can still wake their owner. History remains available.";
  readonly input = { kind: "function" as const, schema: dismissArgs };
  constructor(private readonly runner: () => ConversationRunner) {}
  async execute({ to }: z.infer<typeof dismissArgs>, ctx: ToolContext) {
    const runner = this.runner();
    if ((await relationship(runner, ctx.conversationId, to as ConversationId)) !== "children")
      return errorResult("Only a direct child can be dismissed.");
    await runner.putPluginState("subagents", to as ConversationId, "dismissed", true);
    return okResult(`Dismissed ${to} and its subtree.`);
  }
}
