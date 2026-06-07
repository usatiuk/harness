import type {
    CompactionItem,
    ContentBlock,
    ConversationItem,
    ModelConfig,
    ModelContextItem,
    ModelRequest,
    ProviderPayload,
} from "@harness/protocol";
import { wasRunInterrupted } from "./run-state.ts";
import type { HarnessStore } from "./store.ts";

export const DEFAULT_CONTEXT_POLICY_ID = "deterministic-v0";

export class ContextBuilder {
    public constructor(private readonly store: HarnessStore) {}

    public async build(input: {
        conversationId: string;
        runId: string;
        modelConfig: ModelConfig;
        promptFragments: string[];
    }): Promise<ModelRequest> {
        const allItems = await this.store.listConversationItems(
            input.conversationId,
        );
        const compaction = latestCompaction(allItems);
        const coveredThrough = compaction?.coversThroughItemSequence;
        const abandonedSequences = await this.abandonedInputSequences(
            input.conversationId,
        );

        const selectedItems: Array<CompactionItem | Extract<ConversationItem, { type: "message" }>> = [];
        if (compaction) {
            selectedItems.push(compaction);
        }
        selectedItems.push(
            ...allItems.filter(
                (item): item is Extract<ConversationItem, { type: "message" }> =>
                    item.type === "message" &&
                    (coveredThrough === undefined ||
                        item.sequence > coveredThrough) &&
                    !abandonedSequences.has(item.sequence),
            ),
        );

        const selectedItemIds = selectedItems.map((item) => item.id);
        const selectedItemSequences = selectedItems.map(
            (item) => item.sequence,
        );
        const providerPayloads =
            await this.store.listProviderPayloadsForItems({
                conversationId: input.conversationId,
                itemIds: selectedItems
                    .filter((item) => item.type === "message")
                    .map((item) => item.id),
                provider: input.modelConfig.provider,
                modelId: input.modelConfig.modelId,
            });
        const payloadByItemId = firstPayloadByItemId(providerPayloads);
        const contextItems = selectedItems.map((item) =>
            contextItemFromConversationItem(item, payloadByItemId.get(item.id)),
        );

        const contextBuild = await this.store.createContextBuild({
            conversationId: input.conversationId,
            runId: input.runId,
            modelConfig: input.modelConfig,
            ...(compaction ? { compactionItemId: compaction.id } : {}),
            selectedItemIds,
            selectedItemSequences,
            diagnostics: {
                selectedItemCount: selectedItems.length,
                selectedMessageItemCount: selectedItems.filter(
                    (item) => item.type === "message",
                ).length,
                compactionSequence:
                    compaction?.coversThroughItemSequence ?? null,
                providerPayloadCount: contextItems.filter(
                    (item) => item.providerPayload !== undefined,
                ).length,
            },
        });
        return {
            conversationId: input.conversationId,
            runId: input.runId,
            contextBuildId: contextBuild.id,
            modelConfig: input.modelConfig,
            instructions: input.promptFragments.map((text) => ({
                type: "text",
                text,
            })),
            items: contextItems,
        };
    }

    private async abandonedInputSequences(
        conversationId: string,
    ): Promise<Set<number>> {
        const cancelledRunIds = new Set(
            (await this.store.listAgentRuns(conversationId))
                .filter(
                    (run) =>
                        run.status === "cancelled" &&
                        wasRunInterrupted(run.error),
                )
                .map((run) => run.id),
        );
        if (cancelledRunIds.size === 0) {
            return new Set();
        }
        const sequences = new Set<number>();
        for (const build of await this.store.listContextBuilds(
            conversationId,
        )) {
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
    return Math.ceil(textContent(blocks).length / 4);
}

export function summarizeItemsForProjection(
    items: Array<{
        role: string | undefined;
        content: ContentBlock[];
        sequence: number;
    }>,
): ContentBlock[] {
    const lines = items.map((item) => {
        const text = textContent(item.content).replaceAll("\n", " ");
        return `${item.sequence} ${item.role ?? "item"}: ${text}`;
    });
    return [
        {
            type: "text",
            text: `Conversation summary through sequence ${items.at(-1)?.sequence ?? 0}:\n${lines.join("\n").slice(0, 6000)}`,
        },
    ];
}

function latestCompaction(items: ConversationItem[]): CompactionItem | undefined {
    return items
        .filter((item): item is CompactionItem => item.type === "compaction")
        .at(-1);
}

function firstPayloadByItemId(
    payloads: ProviderPayload[],
): Map<string, ProviderPayload> {
    const byItemId = new Map<string, ProviderPayload>();
    for (const payload of payloads) {
        if (!byItemId.has(payload.itemId)) {
            byItemId.set(payload.itemId, payload);
        }
    }
    return byItemId;
}

function contextItemFromConversationItem(
    item: CompactionItem | Extract<ConversationItem, { type: "message" }>,
    providerPayload: ProviderPayload | undefined,
): ModelContextItem {
    if (item.type === "message") {
        return {
            itemId: item.id,
            conversationId: item.conversationId,
            sequence: item.sequence,
            role: item.role,
            content: item.content,
            ...(providerPayload ? { providerPayload } : {}),
        };
    }
    return {
        itemId: item.id,
        conversationId: item.conversationId,
        sequence: item.sequence,
        role: "system",
        content: item.summary,
    };
}

function textContent(blocks: ContentBlock[]): string {
    const text: string[] = [];
    for (const block of blocks) {
        if (block.type !== "text") {
            throw new Error(
                `Context text rendering cannot render ${block.type} content blocks`,
            );
        }
        if (block.text.length > 0) {
            text.push(block.text);
        }
    }
    return text.join("\n");
}
