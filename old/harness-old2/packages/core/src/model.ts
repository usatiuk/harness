import type {
    ModelCapabilities,
    ModelConfig,
    ModelFinalResponseDraft,
    ModelRequest,
    ModelStreamEventDraft,
} from "@harness/protocol";

export interface ModelAdapter {
    id: string;
    provider: string;
    capabilities(): ModelCapabilities;
    validateModelConfig(config: ModelConfig): void;
    stream(input: ModelRequest): AsyncIterable<ModelStreamEventDraft>;
}

export class ModelRegistry {
    private readonly adapters = new Map<string, ModelAdapter>();

    public register(adapter: ModelAdapter): void {
        this.adapters.set(`${adapter.provider}/${adapter.id}`, adapter);
    }

    public resolve(config: ModelConfig): ModelAdapter {
        const adapter = this.adapters.get(
            `${config.provider}/${config.adapter}`,
        );
        if (!adapter) {
            const available = [...this.adapters.keys()].sort();
            throw new Error(
                `No model adapter registered for ${config.provider}/${config.adapter}${available.length ? ` (available: ${available.join(", ")})` : ""}`,
            );
        }
        adapter.validateModelConfig(config);
        return adapter;
    }
}

export class EchoModelAdapter implements ModelAdapter {
    public readonly id = "fake";
    public readonly provider = "fake";

    public capabilities(): ModelCapabilities {
        return { textInput: true, textOutput: true, reasoningMetadata: false };
    }

    public validateModelConfig(config: ModelConfig): void {
        if (config.provider !== this.provider || config.adapter !== this.id) {
            throw new Error(
                `Echo adapter cannot run ${config.provider}/${config.adapter}`,
            );
        }
    }

    public async *stream(
        input: ModelRequest,
    ): AsyncIterable<ModelStreamEventDraft> {
        const text = [
            ...input.instructions,
            ...input.items.flatMap((contextItem) => contextItem.item.content),
        ]
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
        yield* finalResponseEvents({
            assistant: {
                content: [
                    {
                        type: "text",
                        text: text.length > 0 ? `echo: ${text}` : "echo",
                    },
                ],
                metadata: { adapter: "fake" },
            },
        });
    }
}

export function finalResponseEvents(
    response: ModelFinalResponseDraft,
): ModelStreamEventDraft[] {
    const text = renderText(response.assistant.content);
    return [
        ...(text.length > 0
            ? [{ type: "text_delta" as const, delta: text }]
            : []),
        { type: "completed", response },
    ];
}

function renderText(
    blocks: ModelFinalResponseDraft["assistant"]["content"],
): string {
    return blocks
        .map((block) =>
            block.type === "text" ? block.text : JSON.stringify(block.data),
        )
        .filter((text) => text.length > 0)
        .join("\n");
}
