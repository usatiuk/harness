import type {
    ModelCapabilities,
    ModelConfig,
    ModelFinalResponse,
    ModelRequest,
    ModelStreamEvent,
} from "@harness/protocol";

export interface ModelProvider {
    provider: string;
    capabilities(): ModelCapabilities;
    validateModelConfig(config: ModelConfig): void;
    stream(input: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export class ModelRegistry {
    private readonly providers = new Map<string, ModelProvider>();

    public register(provider: ModelProvider): void {
        this.providers.set(provider.provider, provider);
    }

    public resolve(config: ModelConfig): ModelProvider {
        const provider = this.providers.get(config.provider);
        if (!provider) {
            const available = [...this.providers.keys()].sort();
            throw new Error(
                `No model provider registered for ${config.provider}${available.length ? ` (available: ${available.join(", ")})` : ""}`,
            );
        }
        provider.validateModelConfig(config);
        return provider;
    }
}

export class EchoModelProvider implements ModelProvider {
    public readonly provider = "fake";

    public capabilities(): ModelCapabilities {
        return {
            inputContent: ["text"],
            outputContent: ["text"],
            providerPayloads: false,
        };
    }

    public validateModelConfig(config: ModelConfig): void {
        if (config.provider !== this.provider) {
            throw new Error(
                `Echo provider cannot run provider ${config.provider}`,
            );
        }
    }

    public async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const text = [
            ...input.instructions,
            ...input.items.flatMap((contextItem) => contextItem.content),
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
            },
        });
    }
}

export function finalResponseEvents(
    response: ModelFinalResponse,
): ModelStreamEvent[] {
    const text = renderText(response.assistant.content);
    return [
        ...(text.length > 0
            ? [{ type: "text_delta" as const, delta: text }]
            : []),
        { type: "completed", response },
    ];
}

function renderText(
    blocks: ModelFinalResponse["assistant"]["content"],
): string {
    const text: string[] = [];
    for (const block of blocks) {
        if (block.type !== "text") {
            throw new Error(
                `Model text delta cannot render ${block.type} content blocks`,
            );
        }
        if (block.text.length > 0) {
            text.push(block.text);
        }
    }
    return text.join("\n");
}
