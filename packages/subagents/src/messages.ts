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
  resolveFamilyReference,
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
    "List your parent, siblings or children: task names/slugs and status. Use unique names/slugs or explicit parent with subagent_send; canonical IDs disambiguate collisions. Results are paged; pass nextCursor to continue.";
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
    const readable = await Promise.all(
      agents.map(async ({ id, name, slug, ...rest }) => {
        const reference = await readableFamilyReference(runner, ctx.conversationId, id, name, slug);
        return { name, ...(slug !== id ? { slug } : {}), reference, ...rest };
      }),
    );
    return {
      ...okResult(JSON.stringify({ agents: readable, nextCursor })),
      structured: { agents, nextCursor },
    };
  }
}

export class SubagentSendTool implements Tool<z.infer<typeof sendArgs>> {
  readonly essential = true;
  readonly name = "subagent_send";
  readonly description =
    "Send a message to your parent, sibling or child using its unique name/slug from subagent_list, or explicit parent. Ambiguous names reject; use the canonical conversation ID as fallback. Delivery joins its ordinary inbox and wakes it if idle, including after it finished. Returns acceptance, not a reply. Incoming subagent messages also wake your conversation if idle. Subagent communication doesn't need to be human intelligible.";
  readonly input = { kind: "function" as const, schema: sendArgs };
  constructor(private readonly runner: () => ConversationRunner) {}
  async execute({ to, message }: z.infer<typeof sendArgs>, ctx: ToolContext) {
    const runner = this.runner();
    const resolved = await resolveFamilyReference(runner, ctx.conversationId, to);
    if ("error" in resolved) return errorResult(resolved.error);
    const target = resolved.id;
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
    const senderReference = await readableFamilyReference(
      runner,
      target,
      sender.id,
      sender.name,
      sender.slug,
    );
    const recipient = await identity(runner, target);
    const recipientReference = await readableFamilyReference(
      runner,
      ctx.conversationId,
      target,
      recipient.name,
      recipient.slug,
    );
    ctx.signal.throwIfAborted();
    await runner.deliver(
      target,
      {
        source: { kind: "plugin", pluginId: this.name },
        content: [
          {
            type: "text",
            text: `Message from ${sender.name}${senderReference !== sender.name ? ` [${senderReference}]` : ""}:\n${message}`,
          },
        ],
      },
      "steer",
    );
    return okResult(
      `Message accepted by ${recipient.name}${recipientReference !== recipient.name ? ` [${recipientReference}]` : ""}.`,
    );
  }
}

const dismissArgs = z.strictObject({ to: z.string() });
export class SubagentDismissTool implements Tool<z.infer<typeof dismissArgs>> {
  readonly essential = true;
  readonly name = "subagent_dismiss";
  readonly description =
    "Dismiss one of your direct children by unique name/slug (canonical ID fallback) and its subtree from the active roster, freeing a child slot. They disappear from subagent_list and reject family messages, except messages to a direct parent. Existing activities can still wake their owner. History remains available.";
  readonly input = { kind: "function" as const, schema: dismissArgs };
  constructor(private readonly runner: () => ConversationRunner) {}
  async execute({ to }: z.infer<typeof dismissArgs>, ctx: ToolContext) {
    const runner = this.runner();
    const resolved = await resolveFamilyReference(runner, ctx.conversationId, to, "children");
    if ("error" in resolved) return errorResult(resolved.error);
    if ((await relationship(runner, ctx.conversationId, resolved.id)) !== "children")
      return errorResult("Only a direct child can be dismissed.");
    const child = await identity(runner, resolved.id);
    const reference = await readableFamilyReference(
      runner,
      ctx.conversationId,
      child.id,
      child.name,
      child.slug,
      "children",
    );
    await runner.putPluginState("subagents", resolved.id, "dismissed", true);
    ctx.emit({
      type: "subagents.changed",
      conversationId: ctx.conversationId,
      dismissedId: resolved.id,
    });
    return okResult(
      `Dismissed ${child.name}${reference !== child.name ? ` [${reference}]` : ""} and its subtree.`,
    );
  }
}

/** Resolve display references in the recipient's actual family scope; IDs are only a fallback. */
async function readableFamilyReference(
  runner: ConversationRunner,
  caller: ConversationId,
  id: ConversationId,
  name: string,
  slug: string,
  scope: "family" | "children" = "family",
) {
  if ((await relationship(runner, caller, id)) === "parent") return "parent";
  for (const candidate of [slug, name]) {
    if (candidate === id) continue;
    const resolved = await resolveFamilyReference(runner, caller, candidate, scope);
    if ("id" in resolved && resolved.id === id) return candidate;
  }
  return id;
}
