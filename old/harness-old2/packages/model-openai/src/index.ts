import OpenAI from "openai";
import {
    OpenAIResponsesProvider,
    buildOpenAIResponseInput,
    buildOpenAIResponseParams,
} from "@harness/model-openai-common";

export const OPENAI_PROVIDER = "openai";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

export { buildOpenAIResponseInput, buildOpenAIResponseParams };

export interface OpenAIResponsesModelProviderOptions {
    apiKey?: string;
}

export class OpenAIResponsesModelProvider extends OpenAIResponsesProvider {
    public constructor(options: OpenAIResponsesModelProviderOptions = {}) {
        let clientInstance: OpenAI | undefined;
        super({
            provider: OPENAI_PROVIDER,
            label: "OpenAI Responses provider",
            client: async () => {
                clientInstance ??= new OpenAI({
                    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
                });
                return clientInstance;
            },
        });
    }
}

export function createOpenAIResponsesModelProvider(
    options: OpenAIResponsesModelProviderOptions = {},
): OpenAIResponsesModelProvider {
    return new OpenAIResponsesModelProvider(options);
}
