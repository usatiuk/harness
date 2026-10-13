import { toolCallKey } from "@harness/protocol";
import type OpenAI from "openai";
import type {
  ContentBlock,
  Item,
  ModelRequest,
  ProviderPayload,
  ToolSchema,
} from "@harness/protocol";
import { readReasoningPayload, readOutputPayload } from "./payload.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * The native assistant message the chat transport assembles per generation. The
 * SDK's assistant `content` is a wide union; the transport always emits plaintext
 * (`string | null`), carrying the untyped `reasoning_content` chat backends use for
 * plaintext chain-of-thought round-trip.
 */
interface AssistantMessageWithReasoning {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
}

type InputItem = OpenAI.Responses.ResponseInputItem;

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** One log item → one Responses input item, or `undefined` to omit it. */
function toInputItem(
  item: Item,
  provider: string,
  model: string,
  // Call ids whose tool is freeform this turn — rendered as `custom_tool_call` rather than
  // a JSON function call.
  freeformCallIds: ReadonlySet<string>,
  rawCallIds: ReadonlySet<string>,
  payload?: ProviderPayload,
): InputItem | undefined {
  switch (item.type) {
    case "message":
      if (item.role === "assistant") {
        const native = readOutputPayload(payload, provider, model);
        if (native?.type === "message") return native;
      }
      return {
        role: item.role,
        content: textOf(item.content),
        ...(item.role === "assistant" &&
        (item.phase === null || item.phase === "commentary" || item.phase === "final_answer")
          ? { phase: item.phase }
          : {}),
      };
    case "provider_output":
      return undefined;
    case "reasoning": {
      // Replayable only with our own opaque blob; a mismatched/absent payload is skipped
      // rather than sent as bare summary text (the API rejects that).
      const stored = readReasoningPayload(payload, provider, model);
      if (!stored) return undefined;
      return {
        type: "reasoning",
        id: stored.id,
        summary: item.content
          .filter((b) => b.type === "text")
          .map((b) => ({ type: "summary_text" as const, text: b.text })),
        encrypted_content: stored.encryptedContent,
      };
    }
    case "tool_call":
      if (rawCallIds.has(toolCallKey(item)))
        return { role: "assistant", content: `Tool ${item.name}: ${String(item.args)}` };
      // A freeform tool's canonical args are the raw input string; round-trip it natively.
      if (freeformCallIds.has(toolCallKey(item))) {
        return {
          type: "custom_tool_call",
          call_id: item.callId,
          name: item.name,
          input: item.args as string,
        };
      }
      return {
        type: "function_call",
        call_id: item.callId,
        name: item.name,
        arguments: JSON.stringify(item.args),
      };
    case "tool_result":
      if (rawCallIds.has(toolCallKey(item))) return { role: "user", content: textOf(item.content) };
      if (freeformCallIds.has(toolCallKey(item))) {
        return {
          type: "custom_tool_call_output",
          call_id: item.callId,
          output: textOf(item.content),
        };
      }
      return { type: "function_call_output", call_id: item.callId, output: textOf(item.content) };
    case "compaction":
      // No provider concept for a fold; send it as a plain user message.
      return { role: "user", content: textOf(item.content) };
    case "context":
      // Plugin-injected context (e.g. an AGENTS.md); a developer message.
      return { role: "developer", content: textOf(item.content) };
  }
}

function toFunctionTool(
  schema: Extract<ToolSchema, { kind: "function" }>,
): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    strict: false,
  };
}

/** A custom (freeform) tool → a `custom` tool, grammar-constrained when the schema carries one. */
function toCustomTool(
  schema: Extract<ToolSchema, { kind: "custom" }>,
): OpenAI.Responses.CustomTool {
  const grammar = schema.grammar;
  return {
    type: "custom",
    name: schema.name,
    description: schema.description,
    format: grammar
      ? { type: "grammar", syntax: grammar.syntax, definition: grammar.definition }
      : { type: "text" },
  };
}

/** Maps a harness `ModelRequest` onto native Responses streaming params. */
export function buildResponseParams(
  request: ModelRequest,
  reasoning: OpenAI.Reasoning | undefined,
  provider: string,
  includeEncryptedReasoning: boolean,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  // Freeform tools round-trip as `custom_tool_call` items. A tool_result carries only its
  // callId, so pre-scan the calls to know which results render as custom output.
  const freeformNames = new Set(
    request.tools?.filter((t) => t.kind === "custom").map((t) => t.name) ?? [],
  );
  const freeformCallIds = new Set<string>();
  for (const { item } of request.items) {
    if (item.type === "tool_call" && freeformNames.has(item.name))
      freeformCallIds.add(toolCallKey(item));
  }
  const rawCallIds = new Set(
    request.items.flatMap(({ item }) =>
      item.type === "tool_call" &&
      typeof item.args === "string" &&
      !freeformCallIds.has(toolCallKey(item))
        ? [toolCallKey(item)]
        : [],
    ),
  );

  const input: InputItem[] = [];
  for (const { item, payload } of request.items) {
    const mapped = toInputItem(
      item,
      provider,
      request.modelConfig.model,
      freeformCallIds,
      rawCallIds,
      payload,
    );
    if (mapped) input.push(mapped);
  }
  if (request.prompt) {
    input.push({ role: "user", content: request.prompt });
  }

  const tools: OpenAI.Responses.Tool[] =
    request.tools?.map((t) => {
      if (t.kind === "custom") return toCustomTool(t);
      return toFunctionTool(t);
    }) ?? [];
  if (
    request.providerOptions &&
    typeof request.providerOptions === "object" &&
    !Array.isArray(request.providerOptions) &&
    request.providerOptions.webSearch === true
  )
    tools.push({ type: "web_search" });

  return {
    model: request.modelConfig.model,
    instructions: textOf(request.instructions),
    input,
    stream: true,
    store: false, // stateless: we own the log and round-trip reasoning via encrypted_content
    ...(includeEncryptedReasoning ? { include: ["reasoning.encrypted_content" as const] } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** One function tool → the native chat tool. Chat is function-only; custom tools throw. */
function toChatTool(schema: Extract<ToolSchema, { kind: "function" }>): ChatTool {
  return {
    type: "function",
    function: { name: schema.name, description: schema.description, parameters: schema.parameters },
  };
}

/**
 * The single leading system message: the instructions followed by every context
 * item's text, joined by blank lines. Context items are hoisted here (position is
 * not preserved) so the wire carries at most one system message, which chat
 * backends require.
 */
function chatSystemContent(instructions: ContentBlock[], contextTexts: string[]): string {
  const parts = [textOf(instructions), ...contextTexts].filter((t) => t.length > 0);
  return parts.join("\n\n");
}

/**
 * Maps a harness `ModelRequest` onto native streaming chat/completions params.
 * Chat is function-only (freeform `custom` tools throw), reasoning round-trips as
 * plaintext `reasoning_content`, and instructions + context render as a single
 * leading system message.
 *
 * One model generation is a SINGLE assistant message on the wire, so the log's
 * split items (`reasoning` / `message` / `tool_call`) re-combine per generation
 * into that native shape: `{ role: "assistant", content, reasoning_content,
 * tool_calls }`. The reasoning of a tool-calling turn must ride the same message
 * that carries its tool calls — DeepSeek's thinking mode rejects requests that
 * drop it ("must be passed back to the API"). A reasoning item with no assistant
 * output before a user-side boundary still round-trips as a standalone
 * `{ role: "assistant", content: null, reasoning_content }`.
 */
export function buildChatParams(
  request: ModelRequest,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  // Chat backends cannot carry freeform custom tools; a chat-family request must
  // never offer one (the string_replace profile guarantees this, and the
  // completions-compatible schema rejects apply_patch).
  const tools: ChatTool[] = (request.tools ?? []).map((t) => {
    if (t.kind !== "function") {
      throw new Error(`chat transport is function-only; custom tool "${t.name}" cannot be sent`);
    }
    return toChatTool(t);
  });

  const messages: ChatMessage[] = [];
  // Context items are hoisted into the leading system message (not rendered at
  // their position), so collect their text while mapping the rest of the log.
  const contextTexts: string[] = [];
  // The current generation's native assistant message, assembled from its split
  // log items. Every assistant-side item between two user-side boundaries belongs
  // to the same model response and folds into this one message — content,
  // reasoning_content, and tool_calls together.
  let assistant: AssistantMessageWithReasoning | undefined;

  // Close the generation's assistant message (including the reasoning-only
  // degenerate case it opened) and emit it.
  const flushAssistant = (): void => {
    if (assistant) {
      messages.push(assistant);
      assistant = undefined;
    }
  };

  // Open the generation's assistant message on its first assistant-side item.
  const ensureAssistant = (): AssistantMessageWithReasoning =>
    (assistant ??= { role: "assistant", content: null });
  const rawCallIds = new Set(
    request.items.flatMap(({ item }) =>
      item.type === "tool_call" && typeof item.args === "string" ? [toolCallKey(item)] : [],
    ),
  );

  for (const { item, payload } of request.items) {
    switch (item.type) {
      case "reasoning": {
        if (
          payload?.provider !== request.modelConfig.provider ||
          payload.model !== request.modelConfig.model ||
          payload.type !== "chat_reasoning" ||
          payload.version !== 1
        )
          break;
        // Plaintext round-trip: no encrypted_content, no signature. The fold is
        // position-independent — the item normally precedes the text, but a
        // reasoning item seen after the message is open folds into it too.
        const msg = ensureAssistant();
        msg.reasoning_content = (msg.reasoning_content ?? "") + textOf(item.content);
        break;
      }
      case "message":
        // A plugin-appended system message would create a second system message,
        // which chat backends reject; fail fast rather than emit it.
        if (item.role === "system") {
          throw new Error(
            "chat transport emits at most one system message; a system-role message item is not allowed",
          );
        }
        if (item.role === "assistant") {
          const text = textOf(item.content);
          const msg = ensureAssistant();
          msg.content = msg.content === null ? text : msg.content + text;
        } else {
          flushAssistant();
          messages.push({ role: item.role, content: textOf(item.content) });
        }
        break;
      case "provider_output":
        break;
      case "tool_call":
        {
          if (rawCallIds.has(toolCallKey(item))) {
            flushAssistant();
            messages.push({
              role: "assistant",
              content: `Tool ${item.name}: ${String(item.args)}`,
            });
            break;
          }
          const msg = ensureAssistant();
          (msg.tool_calls ??= []).push({
            id: item.callId,
            type: "function" as const,
            function: { name: item.name, arguments: JSON.stringify(item.args) },
          });
        }
        break;
      case "tool_result":
        // tool_result.status is not transmitted — same as the Responses transport.
        flushAssistant();
        messages.push(
          rawCallIds.has(toolCallKey(item))
            ? { role: "user", content: textOf(item.content) }
            : { role: "tool", tool_call_id: item.callId, content: textOf(item.content) },
        );
        break;
      case "compaction":
        flushAssistant();
        messages.push({ role: "user", content: textOf(item.content) });
        break;
      case "context":
        flushAssistant();
        contextTexts.push(textOf(item.content));
        break;
    }
  }
  flushAssistant();

  const system = chatSystemContent(request.instructions, contextTexts);
  if (system.length > 0) messages.unshift({ role: "system", content: system });
  if (request.prompt) {
    messages.push({ role: "user", content: request.prompt });
  }

  return {
    model: request.modelConfig.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}
