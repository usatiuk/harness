import OpenAI from "openai";
import type { OpenAIChatGptAuthManager, OpenAIChatGptSession } from "@harness/auth-openai";
import {
  OpenAIResponsesSdkAdapter,
  type OpenAIResponsesClient
} from "@harness/model-openai-common";

export const SOURCE_FIRST_MARKER = "harness:model-openai-chatgpt:src";
export const OPENAI_CHATGPT_PROVIDER = "openai-chatgpt";
export const OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID = "codex-responses";
export const DEFAULT_OPENAI_CHATGPT_MODEL = "gpt-5.5";
export const DEFAULT_OPENAI_CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export type OpenAIChatGptClientOptions = ConstructorParameters<typeof OpenAI>[0];

export interface OpenAIChatGptResponsesModelAdapterOptions {
  auth: OpenAIChatGptAuthManager;
  clientFactory?: (session: OpenAIChatGptSession, options: OpenAIChatGptClientOptions) => OpenAIResponsesClient;
  defaultModel?: string;
  baseUrl?: string;
  stream?: boolean;
  userAgent?: string;
}

export class OpenAIChatGptResponsesModelAdapter extends OpenAIResponsesSdkAdapter {
  public constructor(options: OpenAIChatGptResponsesModelAdapterOptions) {
    const createClient = async (forceRefresh = false): Promise<OpenAIResponsesClient> => {
      const session = await options.auth.getValidSession(forceRefresh ? { forceRefresh: true } : {});
      const clientOptions = buildOpenAIChatGptClientOptions(session, {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.userAgent ? { userAgent: options.userAgent } : {})
      });
      return options.clientFactory?.(session, clientOptions) ?? new OpenAI(clientOptions);
    };

    super({
      provider: OPENAI_CHATGPT_PROVIDER,
      adapterId: OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID,
      defaultModel: options.defaultModel ?? process.env.HARNESS_MODEL ?? DEFAULT_OPENAI_CHATGPT_MODEL,
      label: "OpenAI ChatGPT Codex Responses adapter",
      clientFactory: () => createClient(false),
      retryClientFactory: () => createClient(true),
      ...(options.stream === undefined ? {} : { stream: options.stream })
    });
  }
}

export function createOpenAIChatGptResponsesModelAdapter(options: OpenAIChatGptResponsesModelAdapterOptions): OpenAIChatGptResponsesModelAdapter {
  return new OpenAIChatGptResponsesModelAdapter(options);
}

export function buildOpenAIChatGptClientOptions(
  session: OpenAIChatGptSession,
  options: { baseUrl?: string; userAgent?: string } = {}
): OpenAIChatGptClientOptions {
  return {
    apiKey: session.accessToken,
    baseURL: resolveOpenAIChatGptBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_CHATGPT_CODEX_BASE_URL),
    defaultHeaders: {
      "ChatGPT-Account-ID": session.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "harness",
      ...(options.userAgent ? { "User-Agent": options.userAgent } : {})
    }
  };
}

export function resolveOpenAIChatGptBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized.slice(0, -"/responses".length);
  }
  if (normalized.endsWith("/codex")) {
    return normalized;
  }
  return `${normalized}/codex`;
}
