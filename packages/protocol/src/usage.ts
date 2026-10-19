import type { ConversationId, TurnId } from "./ids.ts";
import type { ModelPricing, Usage } from "./model.ts";
import type { Turn } from "./conversation.ts";
import type { JsonValue } from "./rpc.ts";

/** One logical invocation's observed spend. A sidecar fact, never a transcript item. */
export interface ModelUsage {
  id: string;
  conversationId: ConversationId;
  turnId: TurnId;
  /** Links "what the model saw" to "what it cost"; null when no build was recorded. */
  contextBuildId: string | null;
  provider: string;
  /** Snapshotted — conversations can switch models mid-life. */
  model: string;
  /** Stable invocation role. Older records may lack it. */
  purpose?: string;
  /** Actual provider invocations, including failed attempts; zero for a middleware
   * short-circuit without a provider call. Absent on older rows. */
  attempts?: number;
  /** Server-measured request consumption time; excludes subsequent tool dispatch. */
  requestDurationMs?: number;
  /** Usage from the returned completion, or null when absent. With attempts > 1,
   * earlier provider calls are unaccounted and aggregate totals are lower bounds. */
  usage: Usage | null;
  /** Absent means true. Cumulative billing input cannot serve as a context checkpoint. */
  inputTokensAreContext?: boolean;
  /** USD, priced once at record time; null = unknown usage or no rate card. */
  cost: number | null;
  providerUsage?: JsonValue;
  costIncomplete?: boolean;
  createdAt: number;
}

/** Input to record: the store assigns `id` and `createdAt`. */
export type NewModelUsage = Omit<ModelUsage, "id" | "createdAt">;

/** Authoritative bounded-size aggregate for resume and status presentation. */
export interface ModelUsageSummary {
  usage: Usage;
  incomplete: boolean;
  cost: number;
  costIncomplete?: boolean;
  lastInputTokens?: number;
  agentContext?: AgentContextCheckpoint;
  lastTurn?: TurnUsageSummary;
}

export type AgentContextCheckpoint = Pick<
  ModelUsage,
  "provider" | "model" | "turnId" | "usage" | "createdAt"
>;
export interface TurnUsageSummary {
  turnId: TurnId;
  status: Exclude<Turn["status"], "running">;
  usage: Usage;
  incomplete: boolean;
  cost: number;
  costIncomplete?: boolean;
  /** Both null if agent accounting/timing is incomplete (including prior attempts), or none exists. */
  agentOutputTokens: number | null;
  agentDurationMs: number | null;
}
export function summarizeTurnUsage(turn: Turn, rows: readonly ModelUsage[]): TurnUsageSummary {
  if (turn.status === "running") throw new Error("Cannot summarize a terminal turn while running");
  let usage = zeroUsage(),
    cost = 0,
    incomplete = false;
  let costIncomplete = false;
  let agentOutputTokens = 0,
    agentDurationMs = 0,
    agentCount = 0,
    speedKnown = true;
  for (const row of rows) {
    const unobservedAttempts = (row.attempts ?? 0) > 1;
    cost += row.cost ?? 0;
    costIncomplete ||= unobservedAttempts || row.cost === null || row.costIncomplete === true;
    incomplete ||= unobservedAttempts;
    if (row.purpose === undefined) speedKnown = false;
    if (row.usage) usage = addUsage(usage, row.usage);
    else incomplete = true;
    if (row.purpose === "agent") {
      agentCount++;
      if (unobservedAttempts || row.usage === null || row.requestDurationMs === undefined)
        speedKnown = false;
      else {
        agentOutputTokens += row.usage.outputTokens;
        agentDurationMs += row.requestDurationMs;
      }
    }
  }
  return {
    turnId: turn.id,
    status: turn.status,
    usage,
    incomplete,
    cost,
    costIncomplete,
    agentOutputTokens: speedKnown && agentCount > 0 ? agentOutputTokens : null,
    agentDurationMs: speedKnown && agentCount > 0 ? agentDurationMs : null,
  };
}

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
