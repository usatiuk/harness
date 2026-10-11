import type { ConversationId, ConversationRunner } from "@harness/protocol";

/** The durable spawn mark stored under `plugin_state("subagents", childId, "spawn")`. */
export interface SpawnMark {
  parent: { conversationId: ConversationId; callId: string };
  agent: string;
}

/**
 * Depth of a conversation in the subagent tree: how many spawn ancestors it has. Computed only here,
 * at spawn, via a bounded walk up the durable `plugin_state` parent links. A top-level conversation
 * (no spawn mark) is depth 0.
 */
export async function depthOf(
  runner: ConversationRunner,
  id: ConversationId,
  bound: number,
): Promise<number> {
  let depth = 0;
  let current: ConversationId | undefined = id;
  for (let i = 0; i < bound && current !== undefined; i++) {
    const mark = (await runner.getPluginState("subagents", current, "spawn")) as
      SpawnMark | undefined;
    const parent = mark?.parent?.conversationId;
    if (!parent) break; // no mark, or a corrupt one — treat as a tree root
    depth++;
    current = parent;
  }
  return depth;
}

/**
 * Activation-local parent→children index used to inspect the active conversation tree. Settled children remain
 * until session teardown; durable `plugin_state` parentage is the long-term inspection source.
 */
export class SubagentRegistry {
  readonly #children = new Map<ConversationId, Set<ConversationId>>();

  /** Record a freshly spawned child under its parent, for later cascade-stop. */
  track(parent: ConversationId, child: ConversationId): void {
    let set = this.#children.get(parent);
    if (!set) {
      set = new Set();
      this.#children.set(parent, set);
    }
    set.add(child);
  }

  /** Forget the completed active session; durable spawn marks remain available for inspection. */
  clear(): void {
    this.#children.clear();
  }

  /** All live descendants of `root` (children, grandchildren, …), BFS order, excluding `root`. */
  descendantsOf(root: ConversationId): ConversationId[] {
    const out: ConversationId[] = [];
    const queue: ConversationId[] = [root];
    const seen = new Set<ConversationId>([root]);
    while (queue.length > 0) {
      const node = queue.shift()!;
      const kids = this.#children.get(node);
      if (!kids) continue;
      for (const child of kids) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  }
}
