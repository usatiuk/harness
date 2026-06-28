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
      | SpawnMark
      | undefined;
    const parent = mark?.parent?.conversationId;
    if (!parent) break; // no mark, or a corrupt one — treat as a tree root
    depth++;
    current = parent;
  }
  return depth;
}

/**
 * Live in-memory parent→children index for cascade-stop. Settled children are kept (interrupting an
 * idle conversation is a no-op) so the cascade never misses a descendant; nothing to rebuild on reload,
 * since only running conversations need interrupting and none are running yet. `plugin_state` parentage
 * remains the inspection source of truth, not this map.
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

  /** Interrupt every live descendant of `root` (cascade-stop on switch). */
  async stopTree(runner: ConversationRunner, root: ConversationId): Promise<void> {
    await this.#drain(runner, this.descendantsOf(root));
  }

  /** Interrupt every live subagent across all parents (cascade-stop on exit). */
  async stopAll(runner: ConversationRunner): Promise<void> {
    const ids = new Set<ConversationId>();
    for (const set of this.#children.values()) for (const id of set) ids.add(id);
    await this.#drain(runner, [...ids]);
  }

  /**
   * Deliver interrupts, then await settlement. `deliver` resolves once an interrupt is accepted,
   * not once the turn unwinds — so the `updateTurn(…/"aborted")` write that ends the turn is still
   * in flight when it returns. Awaiting `whenIdle` is what keeps that write ahead of `store.close()`
   * (without it, Ctrl-C with running subagents crashes: "The database connection is not open").
   */
  async #drain(runner: ConversationRunner, ids: readonly ConversationId[]): Promise<void> {
    await Promise.all(ids.map((id) => runner.deliver(id, "", "interrupt")));
    await Promise.all(ids.map((id) => runner.whenIdle(id)));
  }
}
