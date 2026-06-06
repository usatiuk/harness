import OpenAI from "openai";
import {
  OpenAIResponsesSdkAdapter,
  buildOpenAIResponseInput,
  buildOpenAIResponseParams,
  type OpenAIResponsesClient
} from "@harness/model-openai-common";

export const SOURCE_FIRST_MARKER = "harness:model-openai:src";
export const OPENAI_RESPONSES_ADAPTER_ID = "responses";
export const OPENAI_PROVIDER = "openai";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

export type { OpenAIResponsesClient } from "@harness/model-openai-common";
export { buildOpenAIResponseInput, buildOpenAIResponseParams };

export interface OpenAIResponsesModelAdapterOptions {
  client?: OpenAIResponsesClient;
  apiKey?: string;
  defaultModel?: string;
  stream?: boolean;
}

export class OpenAIResponsesModelAdapter extends OpenAIResponsesSdkAdapter {
  public constructor(options: OpenAIResponsesModelAdapterOptions = {}) {
    let clientInstance: OpenAIResponsesClient | undefined;
    super({
      provider: OPENAI_PROVIDER,
      adapterId: OPENAI_RESPONSES_ADAPTER_ID,
      defaultModel: options.defaultModel ?? process.env.HARNESS_MODEL ?? DEFAULT_OPENAI_MODEL,
      label: "OpenAI Responses adapter",
      clientFactory: () => {
        clientInstance ??= options.client ?? new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY });
        return clientInstance;
      },
      ...(options.stream === undefined ? {} : { stream: options.stream })
    });
  }
}

export function createOpenAIResponsesModelAdapter(options: OpenAIResponsesModelAdapterOptions = {}): OpenAIResponsesModelAdapter {
  return new OpenAIResponsesModelAdapter(options);
}
