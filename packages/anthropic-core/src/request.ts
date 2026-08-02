import type Anthropic from "@anthropic-ai/sdk";
import {
  textOf,
  type ModelRequest,
  type ProviderPayload,
  type ToolSchema,
} from "@harness/protocol";
import { readThinkingPayload } from "./payload.ts";
import { NATIVE_TOOLS } from "./native-tools.ts";

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type ToolUnion = Anthropic.Messages.ToolUnion;

const EPHEMERAL: Anthropic.Messages.CacheControlEphemeral = { type: "ephemeral" };

/** Per-request knobs the provider resolves from the model + selection and the builder renders. */
export interface AnthropicRequestConfig {
  /** Required by the Messages API; the provider supplies a per-model default. */
  maxTokens: number;
  thinking?: Anthropic.Messages.ThinkingConfigParam;
  effort?: Anthropic.Messages.OutputConfig["effort"];
}

/** A reasoning item's payload → a thinking/redacted block, or `undefined` when it can't replay. */
function thinkingBlock(
  provider: string,
  model: string,
  payload?: ProviderPayload,
): ContentBlockParam | undefined {
  // Replayable only with our own opaque blob (signature-validated). A mismatched/absent payload
  // is dropped — exactly Anthropic's "a different model drops thinking" behavior.
  const stored = readThinkingPayload(payload, provider, model);
  if (!stored) return undefined;
  return stored.kind === "thinking"
    ? { type: "thinking", thinking: stored.thinking, signature: stored.signature }
    : { type: "redacted_thinking", data: stored.data };
}

/**
 * Maps the log's items onto Anthropic messages. Consecutive items of one side merge into a single
 * message: assistant-side items (reasoning, assistant text, tool calls) into one assistant message
 * ordered `[thinking, text, tool_use]` (Anthropic requires thinking before tool_use); user-side
 * items (user/system messages, tool results, compaction, context) into one user message — so a
 * parallel tool turn's results share one message, and there's no developer/system role on the wire.
 */
function toMessages(request: ModelRequest, provider: string): MessageParam[] {
  const model = request.modelConfig.model;
  const messages: MessageParam[] = [];
  let thinking: ContentBlockParam[] = [];
  let text: ContentBlockParam[] = [];
  let toolUse: ContentBlockParam[] = [];
  let user: ContentBlockParam[] = [];

  const flushAssistant = (): void => {
    // A lone thinking block (no text or tool_use to attach to) can't replay — Anthropic rejects it.
    if (text.length > 0 || toolUse.length > 0) {
      messages.push({ role: "assistant", content: [...thinking, ...text, ...toolUse] });
    }
    thinking = [];
    text = [];
    toolUse = [];
  };
  const flushUser = (): void => {
    if (user.length > 0) messages.push({ role: "user", content: user });
    user = [];
  };

  for (const { item, payload } of request.items) {
    switch (item.type) {
      case "reasoning": {
        flushUser();
        const block = thinkingBlock(provider, model, payload);
        if (block) thinking.push(block);
        break;
      }
      case "message":
        if (item.role === "assistant") {
          flushUser();
          const t = textOf(item.content);
          if (t) text.push({ type: "text", text: t });
        } else {
          flushAssistant();
          user.push({ type: "text", text: textOf(item.content) });
        }
        break;
      case "tool_call":
        flushUser();
        toolUse.push({ type: "tool_use", id: item.callId, name: item.name, input: item.args });
        break;
      case "tool_result":
        flushAssistant();
        user.push({
          type: "tool_result",
          tool_use_id: item.callId,
          content: textOf(item.content),
          ...(item.status === "error" ? { is_error: true } : {}),
        });
        break;
      case "compaction":
      case "context":
        flushAssistant();
        user.push({ type: "text", text: textOf(item.content) });
        break;
    }
  }
  flushAssistant();
  flushUser();
  if (request.prompt) {
    messages.push({ role: "user", content: [{ type: "text", text: request.prompt }] });
  }
  return messages;
}

/**
 * Anthropic narrows JSON Schema for custom tools by requiring an explicit top-level object type.
 * Validate that the provider-neutral schema fits that contract; schema generation remains Zod's
 * responsibility rather than being repaired while rendering the request.
 */
function isInputSchema(
  parameters: Record<string, unknown>,
): parameters is Anthropic.Messages.Tool.InputSchema {
  return parameters.type === "object";
}

function toInputSchema(
  parameters: Record<string, unknown>,
  toolName: string,
): Anthropic.Messages.Tool.InputSchema {
  if (!isInputSchema(parameters)) {
    throw new Error(
      `anthropic function tool '${toolName}' requires a top-level object input schema`,
    );
  }
  for (const keyword of ["oneOf", "allOf", "anyOf"] as const) {
    if (parameters[keyword] !== undefined) {
      throw new Error(
        `anthropic function tool '${toolName}' does not support top-level ${keyword}`,
      );
    }
  }
  return parameters;
}

/** A harness tool schema → an Anthropic tool. `native` resolves via the provider's id table. */
function toTool(schema: ToolSchema): ToolUnion {
  if (schema.kind === "native") {
    const wire = NATIVE_TOOLS[schema.id];
    if (!wire) throw new Error(`unknown native tool id: ${schema.id}`);
    return wire;
  }
  if (schema.kind === "function") {
    return {
      name: schema.name,
      description: schema.description,
      input_schema: toInputSchema(schema.parameters, schema.name),
    };
  }
  // Anthropic has no freeform/grammar tool, and the engine never routes a custom tool to a Claude
  // model (Claude runs only under the text_editor profile), so reaching here is a wiring bug.
  throw new Error(`anthropic cannot render custom tool: ${schema.name}`);
}

/** Marks the last cacheable block (text/tool_use/tool_result) as an ephemeral cache breakpoint. */
function markLastCacheable(messages: MessageParam[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    if (typeof content === "string") continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]!;
      if (block.type === "text" || block.type === "tool_use" || block.type === "tool_result") {
        block.cache_control = EPHEMERAL;
        return;
      }
    }
  }
}

/** Maps a harness `ModelRequest` onto native Messages streaming params. */
export function buildMessages(
  request: ModelRequest,
  config: AnthropicRequestConfig,
  provider: string,
): Anthropic.Messages.MessageCreateParamsStreaming {
  const messages = toMessages(request, provider);
  markLastCacheable(messages);

  // System and tools form the static, cache-stable prefix; one breakpoint on the last system
  // block caches both (tools render before system in Anthropic's cache hierarchy).
  const instructions = textOf(request.instructions);
  const system: Anthropic.Messages.TextBlockParam[] | undefined = instructions
    ? [{ type: "text", text: instructions, cache_control: EPHEMERAL }]
    : undefined;

  const tools = request.tools?.map(toTool) ?? [];

  return {
    model: request.modelConfig.model,
    max_tokens: request.maxOutputTokens ?? config.maxTokens,
    messages,
    stream: true,
    ...(system ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.toolChoice ? { tool_choice: { type: request.toolChoice } } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
    ...(config.effort ? { output_config: { effort: config.effort } } : {}),
  };
}
