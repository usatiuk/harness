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

/** Resolve only the caller's visible family. Authorization still runs on the canonical ID. */
export async function resolveFamilyReference(
  runner: ConversationRunner,
  caller: ConversationId,
  reference: string,
  scope: "family" | "children" = "family",
): Promise<{ id: ConversationId } | { error: string }> {
  const parent = (await spawnMark(runner, caller))?.parent.conversationId as
    ConversationId | undefined;
  if (reference === "parent")
    return parent ? { id: parent } : { error: "This conversation has no parent." };
  // IDs remain usable for denied/dismissed targets so the existing authorization is authoritative.
  if (await runner.getConversation(reference as ConversationId))
    return { id: reference as ConversationId };
  const matches = new Set<ConversationId>();
  const consider = async (id: ConversationId) => {
    if (id === caller) return;
    const member = await identity(runner, id);
    if (member.name === reference || member.slug === reference) matches.add(id);
  };
  if (parent && scope === "family") await consider(parent);
  for (const owner of [caller, ...(parent && scope === "family" ? [parent] : [])]) {
    let cursor: { createdAt: number; id: string } | undefined;
    for (;;) {
      const page = await rosterPage(runner, owner, 100, cursor);
      for (const row of page) await consider(row.id);
      if (page.length < 100) break;
      const last = page.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  }
  if (matches.size > 1)
    return { error: `Ambiguous family reference: ${reference}. Use a canonical conversation ID.` };
  const id = matches.values().next().value;
  return id
    ? { id }
    : {
        error: `Unknown family reference: ${reference}. Use subagent_list or a canonical conversation ID.`,
      };
}
