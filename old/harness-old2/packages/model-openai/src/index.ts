import OpenAI from "openai";
import {
  OpenAIResponsesSdkAdapter,
  buildOpenAIResponseInput,
  buildOpenAIResponseParams
} from "@harness/model-openai-common";

export const OPENAI_RESPONSES_ADAPTER_ID = "responses";
export const OPENAI_PROVIDER = "openai";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

export { buildOpenAIResponseInput, buildOpenAIResponseParams };

export interface OpenAIResponsesModelAdapterOptions {
  client?: OpenAI;
  apiKey?: string;
  defaultModel?: string;
}

export class OpenAIResponsesModelAdapter extends OpenAIResponsesSdkAdapter {
  public constructor(options: OpenAIResponsesModelAdapterOptions = {}) {
    let clientInstance: OpenAI | undefined;
    super({
      provider: OPENAI_PROVIDER,
      adapterId: OPENAI_RESPONSES_ADAPTER_ID,
      defaultModel: options.defaultModel ?? process.env.HARNESS_MODEL ?? DEFAULT_OPENAI_MODEL,
      label: "OpenAI Responses adapter",
      client: async () => {
        clientInstance ??= options.client ?? new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY });
        return clientInstance;
      }
    });
  }
}

export function createOpenAIResponsesModelAdapter(options: OpenAIResponsesModelAdapterOptions = {}): OpenAIResponsesModelAdapter {
  return new OpenAIResponsesModelAdapter(options);
}
