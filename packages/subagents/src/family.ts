import { z } from "zod";
import type { ConversationId, ConversationRunner } from "@harness/protocol";

const spawnSchema = z.object({
  parent: z.object({ conversationId: z.string(), callId: z.string() }),
  agent: z.string(),
  name: z.string().optional(),
  slug: z.string().optional(),
});

export async function spawnMark(runner: ConversationRunner, id: ConversationId) {
  const value = await runner.getPluginState("subagents", id, "spawn");
  return value === undefined ? undefined : spawnSchema.parse(value);
}

export async function identity(runner: ConversationRunner, id: ConversationId) {
  const record = await runner.getConversation(id);
  if (!record) throw new Error(`Unknown conversation: ${id}`);
  const mark = await spawnMark(runner, id);
  return {
    id,
    name: mark?.name ?? mark?.agent ?? record.title ?? "Untitled conversation",
    slug: mark?.slug ?? id,
  };
}

/** Root first, including the requested conversation. Shared by labels and ownership restoration. */
export async function ancestorChain(runner: ConversationRunner, id: ConversationId) {
  const chain: Awaited<ReturnType<typeof identity>>[] = [];
  const seen = new Set<string>();
  let current: ConversationId | undefined = id;
  while (current !== undefined) {
    if (seen.has(current)) throw new Error("Subagent parent cycle");
    seen.add(current);
    chain.push(await identity(runner, current));
    current = (await spawnMark(runner, current))?.parent.conversationId as
      ConversationId | undefined;
  }
  return chain.reverse();
}

export function childrenPage(
  runner: ConversationRunner,
  parent: ConversationId,
  limit: number,
  cursor?: { createdAt: number; id: string },
) {
  return runner.listConversationPage(
    limit,
    cursor ? { ...cursor, id: cursor.id as ConversationId } : undefined,
    { includedState: { plugin: "subagents", key: "spawn", scope: parent } },
  );
}

export async function conversationStatus(runner: ConversationRunner, id: ConversationId) {
  const turn = await runner.getLatestTurn(id);
  if (turn?.status === "running" && runner.isConversationRunning(id)) return "running" as const;
  return !turn || turn.status === "running" ? ("aborted" as const) : turn.status;
}

/** Family authorization depends on durable parent links, never caller-supplied names. */
export async function relationship(
  runner: ConversationRunner,
  from: ConversationId,
  to: ConversationId,
) {
  if (from === to) return undefined;
  const [sender, target] = await Promise.all([spawnMark(runner, from), spawnMark(runner, to)]);
  if (sender?.parent.conversationId === to) return "parent" as const;
  if (target?.parent.conversationId === from) return "children" as const;
  if (sender && target?.parent.conversationId === sender.parent.conversationId)
    return "siblings" as const;
  return undefined;
}

/** One durable dismissal flag covers a branch; activity/input lifetimes stay unchanged. */
export async function isDismissed(
  runner: ConversationRunner,
  id: ConversationId,
): Promise<boolean> {
  const seen = new Set<string>();
  let current: ConversationId | undefined = id;
  while (current !== undefined) {
    if (seen.has(current)) throw new Error("Subagent parent cycle");
    seen.add(current);
    if ((await runner.getPluginState("subagents", current, "dismissed")) === true) return true;
    current = (await spawnMark(runner, current))?.parent.conversationId as
      ConversationId | undefined;
  }
  return false;
}

export async function rosterPage(
  runner: ConversationRunner,
  parent: ConversationId,
  limit: number,
  cursor?: { createdAt: number; id: string },
) {
  if (await isDismissed(runner, parent)) return [];
  return runner.listConversationPage(
    limit,
    cursor ? { ...cursor, id: cursor.id as ConversationId } : undefined,
    {
      includedState: { plugin: "subagents", key: "spawn", scope: parent },
      excludedState: { plugin: "subagents", key: "dismissed" },
    },
  );
}
