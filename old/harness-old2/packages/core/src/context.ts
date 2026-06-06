import type {
  ContentBlock,
  ContextProjection,
  JsonValue,
  ModelConfig,
  ModelContextMessage,
  ModelStepInput,
  ProviderState
} from "@harness/protocol";
import type { HarnessStore } from "./store.ts";

export const DEFAULT_CONTEXT_POLICY_ID = "deterministic-v0";

export class ContextBuilder {
  public constructor(private readonly store: HarnessStore) {}

  public async build(input: {
    conversationId: string;
    runId: string;
    modelConfig: ModelConfig;
    promptFragments: string[];
  }): Promise<ModelStepInput> {
    const items = await this.store.listConversationItems(input.conversationId);
    const projections = await this.store.listContextProjections(input.conversationId);
    const projection = projections.at(-1);
    const coveredThrough = projection?.coversThroughItemSequence;
    const abandonedSequences = await this.abandonedInputSequences(input.conversationId);
    const transcriptItems = items.filter((item) =>
      item.class === "transcript" &&
      item.visibility === "model" &&
      (coveredThrough === undefined || item.sequence > coveredThrough) &&
      !abandonedSequences.has(item.sequence) &&
      item.role !== undefined
    );
    const messages: ModelContextMessage[] = [];
    const selectedItemIds: string[] = [];
    const selectedItemSequences: number[] = [];

    const systemFragments: ContentBlock[] = input.promptFragments.map((text) => ({ type: "text", text }));
    if (projection) {
      systemFragments.push(...projection.content);
      selectedItemIds.push(projection.itemId);
    }
    if (systemFragments.length > 0) {
      messages.push({ role: "system", content: systemFragments, metadata: { source: "system" } });
    }

    for (const item of transcriptItems) {
      if (!item.role) {
        continue;
      }
      messages.push({
        role: item.role,
        content: item.content,
        metadata: { itemId: item.id, sequence: item.sequence }
      });
      selectedItemIds.push(item.id);
      selectedItemSequences.push(item.sequence);
    }

    const providerState = this.providerStateForPrompt(input.modelConfig, await this.store.getLatestProviderState(input.conversationId), selectedItemSequences, projection);
    const contextBuild = await this.store.createContextBuild({
      conversationId: input.conversationId,
      runId: input.runId,
      modelConfig: input.modelConfig,
      ...(projection ? { projectionId: projection.id } : {}),
      selectedItemIds,
      selectedItemSequences,
      diagnostics: {
        selectedTranscriptItemCount: transcriptItems.length,
        projectionSequence: projection?.coversThroughItemSequence ?? null,
        providerStateSelected: providerState !== undefined
      }
    });
    return {
      conversationId: input.conversationId,
      runId: input.runId,
      contextBuildId: contextBuild.id,
      modelConfig: input.modelConfig,
      messages,
      ...(providerState ? { providerState } : {})
    };
  }

  private providerStateForPrompt(
    modelConfig: ModelConfig,
    providerState: ProviderState | undefined,
    selectedSequences: number[],
    projection: ContextProjection | undefined
  ): ProviderState | undefined {
    if (!providerState) {
      return undefined;
    }
    if (providerState.provider !== modelConfig.provider || providerState.adapter !== modelConfig.adapter || providerState.modelId !== modelConfig.modelId) {
      return undefined;
    }
    if (projection && providerState.referencedItemSequences.some((sequence) => sequence <= projection.coversThroughItemSequence)) {
      return undefined;
    }
    const selected = new Set(selectedSequences);
    if (!providerState.referencedItemSequences.every((sequence) => selected.has(sequence))) {
      return undefined;
    }
    return providerState;
  }

  private async abandonedInputSequences(conversationId: string): Promise<Set<number>> {
    const cancelledRunIds = new Set(
      (await this.store.listAgentRuns(conversationId))
        .filter((run) => run.status === "cancelled" && wasInterrupted(run.error))
        .map((run) => run.id)
    );
    if (cancelledRunIds.size === 0) {
      return new Set();
    }
    const sequences = new Set<number>();
    for (const build of await this.store.listContextBuilds(conversationId)) {
      if (!cancelledRunIds.has(build.runId)) {
        continue;
      }
      for (const sequence of build.selectedItemSequences) {
        sequences.add(sequence);
      }
    }
    return sequences;
  }
}

export function estimateTokens(blocks: ContentBlock[]): number {
  const text = blocks.map((block) => block.type === "text" ? block.text : JSON.stringify(block.data)).join("\n");
  return Math.ceil(text.length / 4);
}

export function summarizeItemsForProjection(items: Array<{ role: string | undefined; content: ContentBlock[]; sequence: number }>): ContentBlock[] {
  const lines = items.map((item) => {
    const text = item.content.map((block) => block.type === "text" ? block.text : JSON.stringify(block.data)).join(" ");
    return `${item.sequence} ${item.role ?? "item"}: ${text}`;
  });
  return [{ type: "text", text: `Conversation summary through sequence ${items.at(-1)?.sequence ?? 0}:\n${lines.join("\n").slice(0, 6000)}` }];
}

function wasInterrupted(value: JsonValue | undefined): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.interrupted === true;
}
