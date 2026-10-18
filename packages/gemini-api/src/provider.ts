import { toolCallKey, mergeModelMetadata, type ModelMetadata } from "@harness/protocol";
import { GoogleGenAI, ApiError, type Interactions } from "@google/genai";
import { classifyTransientFailure } from "./errors.ts";
import {
  ModelDiscoveryError,
  jsonValueSchema,
  textOf,
  type ContentBlock,
  type ModelConfig,
  type ModelInfo,
  type ModelOutputItem,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ProviderPayload,
  type ProviderPayloadDraft,
} from "@harness/protocol";

type NativeOutput = Exclude<ModelOutputItem, { type: "provider_output" }>;

function isFunctionArgs(args: unknown): args is Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args);
}

function completedSearchFilter(
  steps: readonly Interactions.Step[],
): (step: Interactions.Step) => boolean {
  const calls = new Set(
    steps.flatMap((step) => (step.type === "google_search_call" ? [step.id] : [])),
  );
  const results = new Set(
    steps.flatMap((step) => (step.type === "google_search_result" ? [step.call_id] : [])),
  );
  return (step) =>
    step.type === "google_search_call"
      ? results.has(step.id)
      : step.type === "google_search_result"
        ? calls.has(step.call_id)
        : true;
}

function readSteps(
  payload: ProviderPayload | undefined,
  request: ModelRequest,
): Interactions.Step[] | undefined {
  return payload?.provider === request.modelConfig.provider &&
    payload.model === request.modelConfig.model &&
    payload.type === "interaction_steps" &&
    payload.version === 1
    ? (payload.payload as Interactions.Step[])
    : undefined;
}

function encodeSteps(steps: Interactions.Step[], request: ModelRequest): ProviderPayloadDraft {
  return {
    provider: request.modelConfig.provider,
    model: request.modelConfig.model,
    type: "interaction_steps",
    version: 1,
    payload: jsonValueSchema.parse(steps),
  };
}

const imageContent = (
  content: ContentBlock[],
): (Interactions.ImageContent | Interactions.TextContent)[] =>
  !content.some((block) => block.type === "image")
    ? [{ type: "text", text: textOf(content) }]
    : content.map((block) =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : { type: "image", mime_type: block.mediaType, data: block.data },
      );

export function buildInteraction(
  request: ModelRequest,
  thinking = false,
): Interactions.CreateModelInteractionParamsNonStreaming & { stream: false } {
  const input: Interactions.Step[] = [];
  // Multimodal function results are documented for Gemini 3; older models need user input.
  const nativeToolImages = /^gemini-3/.test(request.modelConfig.model);
  let toolImages: (Interactions.ImageContent | Interactions.TextContent)[] = [];
  const flushToolImages = () => {
    if (toolImages.length) input.push({ type: "user_input", content: toolImages });
    toolImages = [];
  };
  const rawCalls = new Set(
    request.items.flatMap(({ item, payload }) =>
      item.type === "tool_call" && !isFunctionArgs(item.args) && !readSteps(payload, request)
        ? [toolCallKey(item)]
        : [],
    ),
  );
  for (const { item, payload } of request.items) {
    if (item.type === "provider_output") continue;
    if (item.type !== "tool_result") flushToolImages();
    const native = readSteps(payload, request);
    if (
      native &&
      (item.type === "reasoning" ||
        item.type === "tool_call" ||
        (item.type === "message" && item.role === "assistant"))
    ) {
      input.push(...native);
      continue;
    }
    switch (item.type) {
      case "reasoning":
        break;
      case "message":
        input.push({
          type: item.role === "assistant" ? "model_output" : "user_input",
          content: imageContent(item.content),
        });
        break;
      case "tool_call":
        input.push(
          !isFunctionArgs(item.args)
            ? {
                type: "model_output",
                content: [
                  {
                    type: "text",
                    text: `Tool ${item.name}: ${typeof item.args === "string" ? item.args : JSON.stringify(item.args)}`,
                  },
                ],
              }
            : {
                type: "function_call",
                id: item.callId,
                name: item.name,
                arguments: item.args,
              },
        );
        break;
      case "tool_result": {
        const hasImages = item.content.some((block) => block.type === "image");
        const raw = rawCalls.has(toolCallKey(item));
        input.push(
          raw
            ? { type: "user_input", content: imageContent(item.content) }
            : {
                type: "function_result",
                call_id: item.callId,
                result:
                  hasImages && nativeToolImages
                    ? imageContent(item.content)
                    : textOf(item.content) +
                      (hasImages ? "\n[Images follow after tool results.]" : ""),
                is_error: item.status === "error",
              },
        );
        if (hasImages && !nativeToolImages && !raw) {
          toolImages.push(
            { type: "text", text: `Images from tool result ${item.callId}:` },
            ...imageContent(item.content.filter((block) => block.type === "image")),
          );
        }
        break;
      }
      case "compaction":
      case "context":
        input.push({ type: "user_input", content: [{ type: "text", text: textOf(item.content) }] });
        break;
    }
  }
  flushToolImages();
  if (request.prompt)
    input.push({ type: "user_input", content: [{ type: "text", text: request.prompt }] });
  // Correlate the selected assistant history, not each item's sidecar. A pair
  // can straddle readable output, while a rewind can select only its first half.
  const selected: Interactions.Step[] = [];
  let assistant: Interactions.Step[] = [];
  const flushAssistant = () => {
    selected.push(...assistant.filter(completedSearchFilter(assistant)));
    assistant = [];
  };
  for (const step of input) {
    if (step.type === "user_input" || step.type === "function_result") {
      flushAssistant();
      selected.push(step);
    } else assistant.push(step);
  }
  flushAssistant();
  const tools: Interactions.Tool[] = (request.tools ?? []).map((tool) => {
    if (tool.kind !== "function") throw new Error(`gemini cannot render custom tool: ${tool.name}`);
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  });
  if (
    request.providerOptions &&
    typeof request.providerOptions === "object" &&
    !Array.isArray(request.providerOptions) &&
    request.providerOptions.webSearch === true
  )
    tools.push({ type: "google_search" });
  return {
    model: request.modelConfig.model,
    input: selected,
    store: false,
    stream: false,
    system_instruction: textOf(request.instructions),
    tools,
    generation_config: {
      tool_choice: request.toolChoice ?? "auto",
      ...(thinking ? { thinking_summaries: "auto" } : {}),
      ...(request.maxOutputTokens !== undefined
        ? { max_output_tokens: request.maxOutputTokens }
        : {}),
    },
  };
}

/** Finalized native history is context, never an instruction to execute or resume a search. */
export function* interactionEvents(
  result: Interactions.Interaction,
  request: ModelRequest,
): Iterable<ModelStreamEvent> {
  const steps = result.steps ?? [];
  const hasCalls = steps.some((step) => step.type === "function_call");
  const complete =
    result.status === "completed" || (result.status === "requires_action" && hasCalls);
  let error = complete ? undefined : `Gemini interaction stopped: ${result.status}`;
  const output: ModelOutputItem[] = [];
  let pending: Interactions.Step[] = [];
  let last: NativeOutput | undefined;
  let searched = false;
  const keepSearch = completedSearchFilter(steps);
  for (const step of steps) {
    if (step.type === "google_search_call" || step.type === "google_search_result") {
      searched = true;
      if (complete && keepSearch(step)) pending.push(step);
      if (step.type === "google_search_call")
        output.push({
          type: "provider_output",
          content: [
            { type: "text", text: `Searched ${step.arguments.queries?.join(", ") || "the web"}.` },
          ],
        });
      continue;
    }
    let item: NativeOutput;
    if (step.type === "thought" || step.type === "model_output") {
      const blocks = step.type === "thought" ? (step.summary ?? []) : (step.content ?? []);
      const content: ContentBlock[] = blocks.flatMap((block) =>
        block.type === "text" ? [{ type: "text" as const, text: block.text }] : [],
      );
      item = { type: step.type === "thought" ? "reasoning" : "message", content };
      if (blocks.some((block) => block.type !== "text")) {
        error = "Gemini returned unsupported non-text output";
        if (content.length) output.push(item);
        break;
      }
      if (step.type === "model_output" && step.error) {
        error = "Gemini model output reported an error";
        if (content.length) output.push(item);
        break;
      }
    } else if (step.type === "function_call") {
      item = { type: "tool_call", callId: step.id, name: step.name, args: step.arguments };
    } else {
      error = `Gemini returned unexpected output step: ${step.type}`;
      break;
    }
    if (complete) {
      item.payload = encodeSteps([...pending, step], request);
      pending = [];
    }
    output.push(item);
    last = item;
  }
  // A trailing completed search belongs to the preceding finalized item.
  // Metadata never hides later messages or local calls outside the selected log.
  if (last?.payload && pending.length)
    last.payload = encodeSteps(
      [...(last.payload.payload as Interactions.Step[]), ...pending],
      request,
    );
  else if (!error && pending.length)
    output.push({ type: "message", content: [], payload: encodeSteps(pending, request) });
  if (error) for (const item of output) delete item.payload;
  yield* output;
  const usage = result.usage;
  yield {
    type: "completed",
    usage:
      usage?.total_input_tokens !== undefined && usage.total_output_tokens !== undefined
        ? {
            inputTokens: usage.total_input_tokens,
            outputTokens: usage.total_output_tokens + (usage.total_thought_tokens ?? 0),
            cachedReadTokens: usage.total_cached_tokens ?? 0,
          }
        : null,
    ...(usage ? { providerUsage: jsonValueSchema.parse(usage) } : {}),
    ...(searched ? { costIncomplete: true, inputTokensAreContext: false } : {}),
    ...(error ? { error } : {}),
  };
}

/** Harness owns history and local functions; each invocation uses stateless Interactions. */
export class GeminiProvider implements ModelProvider {
  readonly provider: string;
  readonly providerOptions: { readonly webSearch: boolean };
  readonly #client: GoogleGenAI;
  #models: ModelInfo[] = [];
  readonly #configured: Record<string, ModelMetadata>;
  constructor(options: {
    provider: string;
    apiKey: string;
    webSearch?: boolean;
    models?: Record<string, ModelMetadata>;
  }) {
    this.provider = options.provider;
    this.#configured = options.models ?? {};
    this.providerOptions = Object.freeze({ webSearch: options.webSearch ?? false });
    this.#client = new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  }
  capabilities(model: string) {
    return {
      contentTypes: ["text", "image"],
      toolCalling: true,
      customToolInput: this.#configured[model]?.customToolInput ?? {
        supported: false,
        grammars: [],
      },
      preferredEditTool: this.#configured[model]?.preferredEditTool ?? "replace",
    };
  }
  validateConfig(config: ModelConfig): void {
    if (config.preset) throw new Error("Gemini presets are not configured");
  }
  listModels(): ModelInfo[] {
    return mergeModelMetadata(this.provider, this.#models, this.#configured);
  }
  async refreshModels(signal: AbortSignal) {
    const models: ModelInfo[] = [];
    try {
      const pages = await this.#client.models.list({
        config: { pageSize: 100, abortSignal: signal },
      });
      let count = 0;
      for await (const model of pages) {
        if (++count > 5000)
          throw new ModelDiscoveryError("limit", "Gemini catalog exceeds 5000 models");
        if (
          !model.name?.startsWith("models/gemini") ||
          /image|tts|transcribe/i.test(model.name) ||
          !model.supportedActions?.includes("generateContent")
        )
          continue;
        models.push({
          provider: this.provider,
          model: model.name.slice(7),
          // General Gemini models are documented multimodal; specialized audio models are excluded above.
          supportsImages: true,
          ...(model.displayName ? { label: model.displayName } : {}),
          ...(model.inputTokenLimit ? { maxInputTokens: model.inputTokenLimit } : {}),
          ...(model.outputTokenLimit ? { maxOutputTokens: model.outputTokenLimit } : {}),
          ...(model.thinking !== undefined ? { reasoning: { supported: model.thinking } } : {}),
        });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError)
        throw new ModelDiscoveryError(
          "http",
          `Gemini model discovery failed (HTTP ${error.status})`,
          error.status,
        );
      throw error;
    }
    signal.throwIfAborted();
    this.#models = models;
    return { status: "ready" as const, diagnostics: [] };
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const params = buildInteraction(
      request,
      this.listModels().find((model) => model.model === request.modelConfig.model)?.reasoning
        ?.supported === true,
    );
    let result: Interactions.Interaction;
    try {
      result = await this.#client.interactions.create(params, { signal, maxRetries: 0 });
      // Inside the classified region: a pre-first-event stream drop is as transient
      // as a create-time failure (the retry middleware still never re-issues after
      // the first yielded event).
      yield* interactionEvents(result, request);
    } catch (error) {
      throw classifyTransientFailure(error, signal) ?? error;
    }
  }
}
