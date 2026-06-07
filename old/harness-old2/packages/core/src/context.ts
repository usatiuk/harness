import type {
    ConversationItem,
    ContentBlock,
    ModelConfig,
    ModelContextItem,
    ModelRequest,
    ProviderEncoding,
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
        const projections = await this.store.listContextProjections(
            input.conversationId,
        );
        const projection = projections.at(-1);
        const coveredThrough = projection?.coversThroughItemSequence;
        const abandonedSequences = await this.abandonedInputSequences(
            input.conversationId,
        );

        const selectedItems: ConversationItem[] = [];
        const projectionItem = projection
            ? allItems.find((item) => item.id === projection.itemId)
            : undefined;
        if (projectionItem) {
            selectedItems.push(projectionItem);
        }
        selectedItems.push(
            ...allItems.filter(
                (item) =>
                    item.class === "transcript" &&
                    item.visibility === "model" &&
                    (coveredThrough === undefined ||
                        item.sequence > coveredThrough) &&
                    !abandonedSequences.has(item.sequence) &&
                    item.role !== undefined,
            ),
        );

        const selectedItemIds = selectedItems.map((item) => item.id);
        const selectedItemSequences = selectedItems.map(
            (item) => item.sequence,
        );
        const providerEncodings =
            await this.store.listProviderEncodingsForItems({
                conversationId: input.conversationId,
                itemIds: selectedItemIds,
                provider: input.modelConfig.provider,
                adapter: input.modelConfig.adapter,
                modelId: input.modelConfig.modelId,
            });
        const encodingByItemId = firstEncodingByItemId(providerEncodings);
        const contextItems: ModelContextItem[] = selectedItems.map((item) => {
            const providerEncoding = encodingByItemId.get(item.id);
            return {
                item,
                ...(providerEncoding ? { providerEncoding } : {}),
            };
        });

        const contextBuild = await this.store.createContextBuild({
            conversationId: input.conversationId,
            runId: input.runId,
            modelConfig: input.modelConfig,
            ...(projection ? { projectionId: projection.id } : {}),
            selectedItemIds,
            selectedItemSequences,
            diagnostics: {
                selectedItemCount: selectedItems.length,
                selectedTranscriptItemCount: selectedItems.filter(
                    (item) => item.class === "transcript",
                ).length,
                projectionSequence:
                    projection?.coversThroughItemSequence ?? null,
                providerEncodingCount: contextItems.filter(
                    (item) => item.providerEncoding !== undefined,
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
    const text = blocks
        .map((block) =>
            block.type === "text" ? block.text : JSON.stringify(block.data),
        )
        .join("\n");
    return Math.ceil(text.length / 4);
}

export function summarizeItemsForProjection(
    items: Array<{
        role: string | undefined;
        content: ContentBlock[];
        sequence: number;
    }>,
): ContentBlock[] {
    const lines = items.map((item) => {
        const text = item.content
            .map((block) =>
                block.type === "text" ? block.text : JSON.stringify(block.data),
            )
            .join(" ");
        return `${item.sequence} ${item.role ?? "item"}: ${text}`;
    });
    return [
        {
            type: "text",
            text: `Conversation summary through sequence ${items.at(-1)?.sequence ?? 0}:\n${lines.join("\n").slice(0, 6000)}`,
        },
    ];
}

function firstEncodingByItemId(
    encodings: ProviderEncoding[],
): Map<string, ProviderEncoding> {
    const byItemId = new Map<string, ProviderEncoding>();
    for (const encoding of encodings) {
        if (!byItemId.has(encoding.itemId)) {
            byItemId.set(encoding.itemId, encoding);
        }
    }
    return byItemId;
}
