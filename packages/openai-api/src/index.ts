import OpenAI from "openai";
import type { Plugin } from "@harness/protocol";
import { OpenAIResponsesProvider, type OpenAICredentials } from "@harness/openai-core";

export interface ApiKeyOptions {
  apiKey: string;
  baseURL?: string;
}

/** Credentials backed by a single API-key client. */
export function apiKeyCredentials(opts: ApiKeyOptions): OpenAICredentials {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  return { client: () => Promise.resolve(client) };
}

export interface OpenAIPluginOptions {
  apiKey: string;
  baseURL?: string;
  reasoning?: OpenAI.Reasoning;
}

/** Registers the API-key-authenticated OpenAI Responses provider. */
export function createOpenAIPlugin(opts: OpenAIPluginOptions): Plugin {
  const credentials = apiKeyCredentials(opts);
  return {
    id: "openai-api",
    providers: () => [
      new OpenAIResponsesProvider({
        credentials,
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      }),
    ],
  };
}
