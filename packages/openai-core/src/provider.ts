import OpenAI from "openai";
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ProviderCapabilities,
} from "@harness/protocol";
import type { OpenAICredentials } from "./credentials.ts";
import { buildResponseParams } from "./request.ts";
import { toModelEvents } from "./stream.ts";

export interface OpenAIProviderOptions {
  credentials: OpenAICredentials;
  /** Registry name; defaults to `"openai"`. A future OAuth package uses its own. */
  provider?: string;
  /** Reasoning effort/summary; defaults to medium effort with auto summaries. */
  reasoning?: OpenAI.Reasoning;
}

/** A `ModelProvider` backed by the OpenAI Responses API, streaming only. */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly provider: string;
  readonly #credentials: OpenAICredentials;
  readonly #reasoning: OpenAI.Reasoning;

  constructor(opts: OpenAIProviderOptions) {
    this.provider = opts.provider ?? "openai";
    this.#credentials = opts.credentials;
    this.#reasoning = opts.reasoning ?? { effort: "medium", summary: "auto" };
  }

  capabilities(): ProviderCapabilities {
    return { contentTypes: ["text"], toolCalling: true };
  }

  validateConfig(): void {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const client = await this.#credentials.client();
    const params = buildResponseParams(request, this.#reasoning);
    const stream = await client.responses.create(params, { signal });
    yield* toModelEvents(stream, request.modelConfig.model, signal);
  }
}
