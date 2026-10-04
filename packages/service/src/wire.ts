import type {
  Conversation,
  Item,
  ModelInfo,
  ModelPricing,
  ModelUsageSummary,
  Usage,
  WireConversation,
  WireConversationConfig,
  WireItem,
  WireModelInfo,
  WireUsageSummary,
} from "@harness/protocol";
import {
  jsonValueSchema,
  wireConversationSchema,
  wireItemSchema,
  wireModelInfoSchema,
  wireUsageSummarySchema,
} from "@harness/protocol";

export const projectUsage = (usage: Usage) => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedReadTokens: usage.cachedReadTokens,
  cacheWriteTokens:
    usage.cacheWriteTokens === undefined
      ? null
      : Object.fromEntries(
          Object.entries(usage.cacheWriteTokens).map(([ttl, count]) => [String(ttl), count]),
        ),
});

export const projectUsageSummary = (summary: ModelUsageSummary): WireUsageSummary =>
  wireUsageSummarySchema.parse({
    usage: projectUsage(summary.usage),
    incomplete: summary.incomplete,
    cost: summary.cost,
    lastInputTokens: summary.lastInputTokens ?? null,
    agentContext: summary.agentContext
      ? {
          ...summary.agentContext,
          usage: summary.agentContext.usage ? projectUsage(summary.agentContext.usage) : null,
        }
      : null,
    lastTurn: summary.lastTurn
      ? { ...summary.lastTurn, usage: projectUsage(summary.lastTurn.usage) }
      : null,
  });

export const projectConversationConfig = (
  config: Conversation["config"],
): WireConversationConfig => ({
  instructions: config.instructions,
  model: {
    provider: config.model.provider,
    model: config.model.model,
    preset: config.model.preset ?? null,
  },
  tools:
    config.tools === undefined
      ? null
      : { allow: config.tools.allow ?? null, mode: config.tools.mode ?? "direct" },
  plugins: jsonValueSchema.parse(config.plugins ?? {}) as Record<
    string,
    ReturnType<typeof jsonValueSchema.parse>
  >,
});

export const projectConversation = (conversation: Conversation): WireConversation =>
  wireConversationSchema.parse({
    id: conversation.id,
    workspaceRoot: conversation.workspaceRoot,
    overrides: jsonValueSchema.parse(conversation.overrides),
    head: conversation.head,
    createdAt: conversation.createdAt,
    config: projectConversationConfig(conversation.config),
  });

export const projectItem = (item: Item): WireItem =>
  wireItemSchema.parse(
    item.type === "tool_result"
      ? {
          ...item,
          annotations: item.annotations ?? null,
          structured: item.structured === undefined ? null : { value: item.structured },
        }
      : item,
  );

const projectRateCard = (pricing: ModelPricing) => ({
  input: pricing.input,
  output: pricing.output,
  cachedRead: pricing.cachedRead ?? null,
  cacheWrite: pricing.cacheWrite ?? null,
});

export const projectModelInfo = (model: ModelInfo): WireModelInfo =>
  wireModelInfoSchema.parse({
    provider: model.provider,
    model: model.model,
    label: model.label ?? null,
    presets: (model.presets ?? []).map((preset) => ({
      value: preset.value,
      label: preset.label ?? null,
    })),
    defaultPreset: model.defaultPreset ?? null,
    contextWindow: model.contextWindow ?? null,
    maxInputTokens: model.maxInputTokens ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
    reasoning: model.reasoning
      ? {
          supported: model.reasoning.supported ?? null,
          adaptiveThinking: model.reasoning.adaptiveThinking ?? null,
          legacyThinking: model.reasoning.legacyThinking ?? null,
          alwaysOn: model.reasoning.alwaysOn ?? null,
          effortLevels: model.reasoning.effortLevels ?? null,
          defaultEffort: model.reasoning.defaultEffort ?? null,
        }
      : null,
    pricing: model.pricing
      ? {
          ...projectRateCard(model.pricing),
          longContext: model.pricing.longContext
            ? {
                ...projectRateCard(model.pricing.longContext),
                threshold: model.pricing.longContext.threshold,
              }
            : null,
        }
      : null,
  });
