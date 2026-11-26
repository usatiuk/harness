import type { ConversationId, ConversationRunner } from "@harness/protocol";

/** The durable spawn mark stored under `plugin_state("subagents", childId, "spawn")`. */
export interface SpawnMark {
  parent: { conversationId: ConversationId; callId: string };
  agent: string;
  name?: string;
  slug?: string;
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

/** Parent-local spawn admission; the store owns thread parentage and closure. */
export class SubagentRegistry {
  readonly #spawns = new Map<ConversationId, Promise<void>>();

  /** Serialize only spawn admission so parallel calls cannot overfill a parent's roster. */
  async withSpawn<T>(parent: ConversationId, action: () => Promise<T>): Promise<T> {
    const previous = this.#spawns.get(parent) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#spawns.set(parent, pending);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#spawns.get(parent) === pending) this.#spawns.delete(parent);
    }
  }
}
