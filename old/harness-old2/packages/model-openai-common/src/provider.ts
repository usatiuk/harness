import type { ModelProvider } from "@harness/core";
import type {
    ModelCapabilities,
    ModelConfig,
    ModelRequest,
    ModelStreamEvent,
} from "@harness/protocol";
import OpenAI, { APIError } from "openai";
import { streamOpenAIResponses } from "./collect.ts";
import { buildOpenAIResponseParams } from "./request.ts";

export interface OpenAIResponsesProviderOptions {
    provider: string;
    label: string;
    client: () => Promise<OpenAI>;
    refreshClientAfterUnauthorized?: () => Promise<OpenAI>;
}

export class OpenAIResponsesProvider implements ModelProvider {
    public readonly provider: string;
    private readonly label: string;
    private readonly client: () => Promise<OpenAI>;
    private readonly refreshClientAfterUnauthorized:
        | (() => Promise<OpenAI>)
        | undefined;

    public constructor(options: OpenAIResponsesProviderOptions) {
        this.provider = options.provider;
        this.label = options.label;
        this.client = options.client;
        this.refreshClientAfterUnauthorized =
            options.refreshClientAfterUnauthorized;
    }

    public capabilities(): ModelCapabilities {
        return {
            inputContent: ["text"],
            outputContent: ["text"],
            providerPayloads: true,
        };
    }

    public validateModelConfig(config: ModelConfig): void {
        if (config.provider !== this.provider) {
            throw new Error(
                `${this.label} cannot run provider ${config.provider}`,
            );
        }
    }

    public async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
        this.validateModelConfig(input.modelConfig);
        const params = buildOpenAIResponseParams(input);
        try {
            yield* streamOpenAIResponses(input, await this.client(), params);
        } catch (error) {
            const canRefresh =
                error instanceof APIError &&
                (error.status === 401 || error.code === "401") &&
                this.refreshClientAfterUnauthorized !== undefined;
            if (!canRefresh) {
                throw error;
            }
            yield* streamOpenAIResponses(
                input,
                await this.refreshClientAfterUnauthorized(),
                params,
            );
        }
    }
}
