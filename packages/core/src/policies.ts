import {
  assertNever,
  type ContextPolicy,
  type DeliveryPolicy,
  type OutputProjection,
  type ToolGate,
} from "@harness/protocol";

/**
 * The default delivery mapping. Steer-vs-queue lives entirely here: a plugin
 * swaps this policy, never the loop.
 */
export const defaultDeliveryPolicy: DeliveryPolicy = {
  decide({ intent, boundary }) {
    switch (intent) {
      case "send":
        return boundary === "idle" ? "start-turn" : "hold";
      case "queue":
        return "hold";
      case "steer":
        return "inject";
      case "interrupt":
        return "cancel-and-restart";
      default:
        return assertNever(intent);
    }
  },
};

/** Selects every item in order; passes the prefix through unchanged. No compaction yet. */
export const defaultContextPolicy: ContextPolicy = {
  async select({ conversationId, instructions, tools, items, payloads }) {
    return {
      conversationId,
      instructions,
      tools,
      items: items.map((item) => {
        const payload = payloads.get(item.id);
        return payload ? { item, payload } : { item };
      }),
    };
  },
};

export const allowAllToolGate: ToolGate = {
  async evaluate() {
    return "allow";
  },
};

/** Caps each text block; full output (blob redirect) is a later projection. */
export function truncateOutputProjection(maxChars = 10_000): OutputProjection {
  return {
    project(result) {
      const forModel = result.forModel.map((block) =>
        block.type === "text" && block.text.length > maxChars
          ? { type: "text" as const, text: `${block.text.slice(0, maxChars)}…[truncated]` }
          : block,
      );
      return { ...result, forModel };
    },
  };
}
