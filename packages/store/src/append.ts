import type { DistributiveOmit, IdGenerator, Item, ItemAppend } from "@harness/protocol";

export type PreparedItem = DistributiveOmit<Item, "seq" | "parent" | "createdAt">;

/** Resolve groups and the compaction boundary before either store publishes the batch. */
export function prepareItemBatch(inputs: readonly ItemAppend[], ids: IdGenerator): PreparedItem[] {
  const batch: PreparedItem[] = [];
  for (const entry of inputs) {
    const grouped = !("type" in entry);
    const members = grouped ? entry : [entry];
    if (!members.length) throw new Error("empty history group");
    const itemIds = members.map(() => ids.itemId());
    const group = grouped ? { first: itemIds[0]!, last: itemIds.at(-1)! } : undefined;
    for (const [i, input] of members.entries()) {
      if (input.group !== undefined) throw new Error("history group IDs are store-owned");
      if (batch.length && batch[0]!.conversationId !== input.conversationId)
        throw new Error("mixed conversation batch");
      const id = itemIds[i]!;
      batch.push({
        ...(input.type === "compaction" ? { ...input, windowStart: batch[0]?.id ?? id } : input),
        id,
        ...(group && { group }),
      });
    }
  }
  return batch;
}
