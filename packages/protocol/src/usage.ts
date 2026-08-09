import type { ConversationId, TurnId } from "./ids.ts";
import type { ModelPricing, Usage } from "./model.ts";

/** One provider request's spend. A sidecar fact, never an item: it stays out of the transcript. */
export interface ModelUsage {
  id: string;
  conversationId: ConversationId;
  turnId: TurnId;
  /** Links "what the model saw" to "what it cost"; null when no build was recorded. */
  contextBuildId: string | null;
  provider: string;
  /** Snapshotted — conversations can switch models mid-life. */
  model: string;
  /** `null` records a completed provider invocation whose backend omitted accounting. */
  usage: Usage | null;
  /** USD, priced once at record time; null = unknown usage or no rate card. */
  cost: number | null;
  createdAt: number;
}

/** Input to record: the store assigns `id` and `createdAt`. */
export type NewModelUsage = Omit<ModelUsage, "id" | "createdAt">;

export const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
});

const addTtlMaps = (
  a: Record<number, number> | undefined,
  b: Record<number, number> | undefined,
): Record<number, number> | undefined => {
  if (!a && !b) return undefined;
  const sum: Record<number, number> = { ...a };
  for (const [ttl, count] of Object.entries(b ?? {})) {
    sum[Number(ttl)] = (sum[Number(ttl)] ?? 0) + count;
  }
  return sum;
};

/** Pointwise sum; TTL maps merge key-by-key. */
export function addUsage(a: Usage, b: Usage): Usage {
  const cacheWriteTokens = addTtlMaps(a.cacheWriteTokens, b.cacheWriteTokens);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}

/** USD for one request. Pure — callers run it at record time and store the result. */
export function costOf(usage: Usage, base: ModelPricing): number {
  const long = base.longContext;
  const pricing = long && usage.inputTokens > long.threshold ? long : base;
  const writes = Object.entries(usage.cacheWriteTokens ?? {});
  const writtenTokens = writes.reduce((sum, [, count]) => sum + count, 0);
  const uncachedTokens = usage.inputTokens - usage.cachedReadTokens - writtenTokens;
  let perMillion = uncachedTokens * pricing.input;
  perMillion += usage.cachedReadTokens * (pricing.cachedRead ?? pricing.input);
  for (const [ttl, count] of writes) {
    perMillion += count * (pricing.cacheWrite?.[Number(ttl)] ?? pricing.input);
  }
  perMillion += usage.outputTokens * pricing.output;
  return perMillion / 1_000_000;
}
