import type { ModelAdapter } from "@harness/core";
import type { ModelCapabilities, ModelConfig, ModelRequest, ModelStreamEventDraft } from "@harness/protocol";
import type OpenAI from "openai";
import { streamOpenAIResponses } from "./collect.ts";
import { buildOpenAIResponseParams } from "./request.ts";
import { isRecord } from "./utils.ts";

type OpenAIResponsesSdkClient = Pick<OpenAI, "responses">;

export interface OpenAIResponsesSdkAdapterOptions {
  provider: string;
  adapterId: string;
  defaultModel: string;
  label: string;
  client: () => Promise<OpenAIResponsesSdkClient>;
  refreshClientAfterUnauthorized?: () => Promise<OpenAIResponsesSdkClient>;
  extraBody?: Record<string, unknown>;
}

export class OpenAIResponsesSdkAdapter implements ModelAdapter {
  public readonly id: string;
  public readonly provider: string;
  private readonly defaultModel: string;
  private readonly label: string;
  private readonly client: () => Promise<OpenAIResponsesSdkClient>;
  private readonly refreshClientAfterUnauthorized: (() => Promise<OpenAIResponsesSdkClient>) | undefined;
  private readonly extraBody: Record<string, unknown>;

  public constructor(options: OpenAIResponsesSdkAdapterOptions) {
    this.id = options.adapterId;
    this.provider = options.provider;
    this.defaultModel = options.defaultModel;
    this.label = options.label;
    this.client = options.client;
    this.refreshClientAfterUnauthorized = options.refreshClientAfterUnauthorized;
    this.extraBody = options.extraBody ?? {};
  }

  public capabilities(): ModelCapabilities {
    return { textInput: true, textOutput: true, reasoningMetadata: true };
  }

  public validateModelConfig(config: ModelConfig): void {
    if (config.provider !== this.provider) {
      throw new Error(`${this.label} cannot run provider ${config.provider}`);
    }
    if (config.adapter !== this.id) {
      throw new Error(`${this.label} cannot run adapter ${config.adapter}`);
    }
  }

  public async *stream(input: ModelRequest): AsyncIterable<ModelStreamEventDraft> {
    this.validateModelConfig(input.modelConfig);
    const params = buildOpenAIResponseParams(input, {
      defaultModel: this.defaultModel,
      extraBody: this.extraBody
    });
    try {
      yield* streamOpenAIResponses(input, await this.client(), params);
    } catch (error) {
      if (!isUnauthorizedError(error) || !this.refreshClientAfterUnauthorized) {
        throw error;
      }
      const refreshedClient = await this.refreshClientAfterUnauthorized();
      yield* streamOpenAIResponses(input, refreshedClient, params);
    }
  }
}

function isUnauthorizedError(error: unknown): boolean {
  return isRecord(error) && (error.status === 401 || error.code === 401 || error.code === "401");
}
