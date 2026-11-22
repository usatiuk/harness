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
  contextMeasurements?: ContextMeasurement[];
  cacheRead?: CacheReadCoverage;
  lastTurn?: TurnUsageSummary;
}

export type AgentContextCheckpoint = Pick<
  ModelUsage,
  "provider" | "model" | "turnId" | "usage" | "createdAt"
> & {
  lastRequest?: {
    usage: Usage | null;
    cachedReadTokens: number | null;
    cost: number | null;
    costIncomplete: boolean;
  };
};

export interface ContextMeasurement {
  provider: string;
  model: string;
  inputTokens: number;
  createdAt: number;
}

export interface CacheReadCoverage {
  inputTokens: number;
  cachedReadTokens: number;
  reportedRequests: number;
  totalRequests: number;
}

function usageObject(value: JsonValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Normalization uses zero for both a reported miss and a missing cache count. */
function reportedCacheReads(row: ModelUsage): number | null {
  if (!row.usage) return null;
  const raw = usageObject(row.providerUsage);
  const explicit = [
    usageObject(raw?.input_tokens_details)?.cached_tokens,
    usageObject(raw?.prompt_tokens_details)?.cached_tokens,
    raw?.cache_read_input_tokens,
    raw?.total_cached_tokens,
  ].some((count) => typeof count === "number" && Number.isInteger(count) && count >= 0);
  return explicit || row.usage.cachedReadTokens > 0 ? row.usage.cachedReadTokens : null;
}

/** Fold the same persisted request rows for live updates and reattachment. */
export function summarizeUsageRows(rows: Iterable<ModelUsage>): ModelUsageSummary {
  let usage = zeroUsage();
  let cost = 0;
  let incomplete = false;
  let costIncomplete = false;
  let lastInputTokens: number | undefined;
  let agentContext: AgentContextCheckpoint | undefined;
  const inputByModel = new Map<string, ContextMeasurement>();
  const cacheRead: CacheReadCoverage = {
    inputTokens: 0,
    cachedReadTokens: 0,
    reportedRequests: 0,
    totalRequests: 0,
  };
  for (const row of rows) {
    const attempts = row.attempts ?? 1;
    const partialCost = attempts > 1 || row.costIncomplete === true;
    cost += row.cost ?? 0;
    costIncomplete ||= partialCost || row.cost === null;
    incomplete ||= attempts > 1 || row.usage === null;
    if (row.usage) {
      usage = addUsage(usage, row.usage);
      lastInputTokens = row.usage.inputTokens;
    }
    if (row.inputTokensAreContext === false) lastInputTokens = undefined;
    if (attempts === 0) continue;

    const cachedReadTokens = reportedCacheReads(row);
    cacheRead.totalRequests += attempts;
    if (cachedReadTokens !== null && row.usage) {
      cacheRead.reportedRequests++;
      cacheRead.cachedReadTokens += cachedReadTokens;
      cacheRead.inputTokens += row.usage.inputTokens;
    }
    if (row.purpose === "agent") {
      const contextUsage = row.inputTokensAreContext === false ? null : row.usage;
      if (contextUsage) {
        inputByModel.set(JSON.stringify([row.provider, row.model]), {
          provider: row.provider,
          model: row.model,
          inputTokens: contextUsage.inputTokens,
          createdAt: row.createdAt,
        });
      }
      agentContext = {
        provider: row.provider,
        model: row.model,
        turnId: row.turnId,
        createdAt: row.createdAt,
        usage: contextUsage,
        lastRequest: {
          usage: row.usage,
          cachedReadTokens,
          cost: row.cost,
          costIncomplete: partialCost,
        },
      };
    }
  }
  return {
    usage,
    incomplete,
    cost,
    costIncomplete,
    cacheRead,
    contextMeasurements: [...inputByModel.values()],
    ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
    ...(agentContext ? { agentContext } : {}),
  };
}
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
