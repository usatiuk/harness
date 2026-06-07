import { describe, expect, test } from "vitest";
import type { OpenAIChatGptAuthManager, OpenAIChatGptSession } from "@harness/auth-openai";
import type { OpenAIResponsesClient } from "@harness/model-openai-common";
import {
  buildOpenAIChatGptClientOptions,
  OpenAIChatGptResponsesModelAdapter,
  OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID,
  OPENAI_CHATGPT_PROVIDER,
  resolveOpenAIChatGptBaseUrl
} from "@harness/model-openai-chatgpt";
import { profileConfigSchema, type ModelStepInput } from "@harness/protocol";

describe("OpenAI ChatGPT Codex Responses adapter", () => {
  test("uses SDK-compatible client config for ChatGPT Codex auth", () => {
    const options = buildOpenAIChatGptClientOptions(session("token-1", "account-1"), {
      baseUrl: "https://chatgpt.com/backend-api",
      userAgent: "harness-test"
    });

    expect(options).toMatchObject({
      apiKey: "token-1",
      baseURL: "https://chatgpt.com/backend-api/codex",
      defaultHeaders: {
        "ChatGPT-Account-ID": "account-1",
        "OpenAI-Beta": "responses=experimental",
        originator: "harness",
        "User-Agent": "harness-test"
      }
    });
  });

  test("streams through the shared official SDK Responses path", async () => {
    const createdClients: Array<{ session: OpenAIChatGptSession; options: unknown }> = [];
    const adapter = new OpenAIChatGptResponsesModelAdapter({
      auth: authManager(session("token-1", "account-1")),
      clientFactory: (activeSession, options) => {
        createdClients.push({ session: activeSession, options });
        return mockClient(streamEvents([
          { type: "response.output_text.delta", delta: "hel" },
          { type: "response.output_text.delta", delta: "lo" },
          { type: "response.completed", response: response([outputMessage("msg_1", "hello")]) }
        ]));
      }
    });
    const deltas: string[] = [];

    const result = await adapter.step(modelInput(), {
      onTextDelta(delta) {
        deltas.push(delta);
      }
    });

    expect(createdClients[0]?.session.accessToken).toBe("token-1");
    expect(createdClients[0]?.options).toMatchObject({
      apiKey: "token-1",
      baseURL: "https://chatgpt.com/backend-api/codex"
    });
    expect(deltas).toEqual(["hel", "lo"]);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(JSON.stringify(result.providerEvents)).not.toContain("token-1");
  });

  test("refreshes once and retries through the SDK path on 401", async () => {
    const authCalls: Array<{ forceRefresh?: boolean }> = [];
    const clientTokens: string[] = [];
    const adapter = new OpenAIChatGptResponsesModelAdapter({
      auth: {
        getValidSession: async (options?: { forceRefresh?: boolean }) => {
          authCalls.push(options ?? {});
          return options?.forceRefresh ? session("token-2", "account-2") : session("token-1", "account-1");
        }
      } as OpenAIChatGptAuthManager,
      clientFactory: (activeSession) => {
        clientTokens.push(activeSession.accessToken);
        return activeSession.accessToken === "token-1"
          ? mockClientWithError(Object.assign(new Error("unauthorized"), { status: 401 }))
          : mockClient(streamEvents([{ type: "response.completed", response: response([outputMessage("msg_1", "ok")]) }]));
      }
    });

    const result = await adapter.step(modelInput());

    expect(authCalls).toEqual([{}, { forceRefresh: true }]);
    expect(clientTokens).toEqual(["token-1", "token-2"]);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("normalizes Codex SDK base URLs", () => {
    expect(resolveOpenAIChatGptBaseUrl("https://chatgpt.com/backend-api")).toBe("https://chatgpt.com/backend-api/codex");
    expect(resolveOpenAIChatGptBaseUrl("https://chatgpt.com/backend-api/codex")).toBe("https://chatgpt.com/backend-api/codex");
    expect(resolveOpenAIChatGptBaseUrl("https://chatgpt.com/backend-api/codex/responses")).toBe("https://chatgpt.com/backend-api/codex");
  });
});

function modelInput(overrides: Partial<ModelStepInput> = {}): ModelStepInput {
  return {
    conversationId: "conv_1",
    turnId: "turn_1",
    contextBuildId: "ctx_1",
    effectiveProfile: {
      sourceProfileIds: [],
      resolvedAt: "2026-06-06T00:00:00.000Z",
      config: profileConfigSchema.parse({
        model: { adapter: OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID, provider: OPENAI_CHATGPT_PROVIDER, modelId: "gpt-test", nativeTools: [] },
        enabledTools: []
      })
    },
    modelConfig: {
      adapter: OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID,
      provider: OPENAI_CHATGPT_PROVIDER,
      modelId: "gpt-test",
      nativeTools: []
    },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: {}
      }
    ],
    availableTools: [],
    unsupportedInputBlocks: [],
    ...overrides
  };
}

function authManager(activeSession: OpenAIChatGptSession): OpenAIChatGptAuthManager {
  return {
    getValidSession: async () => activeSession
  } as OpenAIChatGptAuthManager;
}

function session(accessToken: string, accountId: string): OpenAIChatGptSession {
  return {
    version: 1,
    kind: "openai_chatgpt_oauth",
    issuer: "https://auth.openai.com",
    accountId,
    accessToken,
    refreshToken: "refresh",
    idToken: "id",
    expiresAt: Date.now() + 3600_000,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z"
  };
}

function mockClient(data: unknown): OpenAIResponsesClient {
  return {
    responses: {
      create: () => ({
        withResponse: async () => ({
          data: data as any,
          request_id: "req_chatgpt"
        })
      })
    }
  };
}

function mockClientWithError(error: Error): OpenAIResponsesClient {
  return {
    responses: {
      create: () => ({
        withResponse: async () => {
          throw error;
        }
      })
    }
  };
}

function response(output: unknown[], usage?: unknown): any {
  return {
    id: "resp_1",
    status: "completed",
    output,
    ...(usage === undefined ? {} : { usage })
  };
}

function outputMessage(id: string, text: string): any {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  };
}

async function* streamEvents(events: unknown[]): AsyncIterable<any> {
  for (const event of events) {
    yield event;
  }
}
