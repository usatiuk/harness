import { toolCallKey } from "@harness/protocol";
import type OpenAI from "openai";
import type {
  ContentBlock,
  ContextItem,
  ModelRequest,
  ProviderPayload,
  ToolSchema,
} from "@harness/protocol";
import { replayResponseOutput } from "./payload.ts";

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

const responseContent = (
  content: ContentBlock[],
): string | OpenAI.Responses.ResponseInputContent[] =>
  content.some((block) => block.type === "image")
    ? content.map((block) =>
        block.type === "text"
          ? { type: "input_text", text: block.text }
          : {
              type: "input_image",
              image_url: `data:${block.mediaType};base64,${block.data}`,
              detail: "auto",
            },
      )
    : textOf(content);

const chatParts = (content: ContentBlock[]): OpenAI.Chat.Completions.ChatCompletionContentPart[] =>
  content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.data}` } },
  );
const chatContent = (content: ContentBlock[]) =>
  content.some((block) => block.type === "image") ? chatParts(content) : textOf(content);

/** One log item → one Responses input item, or `undefined` to omit it. */
function toInputItem(
  item: ContextItem["item"],
  provider: string,
  model: string,
  systemRole: "system" | "developer",
  // Call ids whose tool is freeform this turn — rendered as `custom_tool_call` rather than
  // a JSON function call.
  freeformCallIds: ReadonlySet<string>,
  rawCallIds: ReadonlySet<string>,
  payload?: ProviderPayload,
): InputItem | undefined {
  switch (item.type) {
    case "message":
      if (item.role === "assistant") {
        const native = replayResponseOutput(item, payload, provider, model);
        if (native) return native;
      }
      return {
        role: item.role === "system" ? systemRole : item.role,
        content: item.role === "assistant" ? textOf(item.content) : responseContent(item.content),
        ...(item.role === "assistant" &&
        (item.phase === null || item.phase === "commentary" || item.phase === "final_answer")
          ? { phase: item.phase }
          : {}),
      };
    case "reasoning":
      return replayResponseOutput(item, payload, provider, model);
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
      if (rawCallIds.has(toolCallKey(item)))
        return { role: "user", content: responseContent(item.content) };
      if (freeformCallIds.has(toolCallKey(item))) {
        return {
          type: "custom_tool_call_output",
          call_id: item.callId,
          output: responseContent(item.content),
        };
      }
      return {
        type: "function_call_output",
        call_id: item.callId,
        output: responseContent(item.content),
      };
    case "compaction":
      // No provider concept for a fold; send it as a plain user message.
      return { role: "user", content: textOf(item.content) };
    case "context":
      return { role: "user", content: textOf(item.content) };
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
  includeEncryptedReasoning?: boolean,
  systemRole: "system" | "developer" = "developer",
): OpenAI.Responses.ResponseCreateParamsStreaming {
  // Freeform tools round-trip as `custom_tool_call` items. A tool_result carries only its
  // callId, so pre-scan the calls to know which results render as custom output.
  const freeformNames = new Set(
    request.tools?.filter((t) => t.kind === "custom").map((t) => t.name) ?? [],
  );
  const freeformCallIds = new Set<string>();
  for (const { item } of request.items) {
    if (item.type === "tool_call" && typeof item.args === "string" && freeformNames.has(item.name))
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
      systemRole,
      freeformCallIds,
      rawCallIds,
      payload,
    );
    if (mapped) input.push(mapped);
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

  // Compatible gateways can request ciphertext once their own history demonstrates support.
  const includeEncrypted =
    includeEncryptedReasoning ??
    (reasoning !== undefined ||
      input.some(
        (item) => "type" in item && item.type === "reasoning" && !!item.encrypted_content,
      ));
  return {
    model: request.modelConfig.model,
    input,
    stream: true,
    store: false,
    ...(includeEncrypted ? { include: ["reasoning.encrypted_content" as const] } : {}),
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
 * Maps a harness `ModelRequest` onto native streaming chat/completions params.
 * Chat is function-only (freeform `custom` tools throw), reasoning round-trips as
 * plaintext `reasoning_content`. File context stays at its recorded position.
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
  // Chat tool messages are text-only. Keep every parallel result adjacent before images.
  let toolImages: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  let rawResults: ChatMessage[] = [];
  let contextNotices: ChatMessage[] = [];
  const flushDeferredResults = (): void => {
    // Historical custom results are also user messages, so defer them past native results.
    messages.push(...rawResults);
    rawResults = [];
    if (toolImages.length) messages.push({ role: "user", content: toolImages });
    toolImages = [];
    messages.push(...contextNotices);
    contextNotices = [];
  };
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
    if (item.type !== "tool_result" && item.type !== "context") flushDeferredResults();
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
        if (item.role === "system") {
          flushAssistant();
          if (messages.length)
            throw new Error("chat transport requires at most one system message at the start");
          messages.push({ role: "system", content: textOf(item.content) });
          break;
        }
        if (item.role === "assistant") {
          const text = textOf(item.content);
          const msg = ensureAssistant();
          msg.content = msg.content === null ? text : msg.content + text;
        } else {
          flushAssistant();
          messages.push({ role: item.role, content: chatContent(item.content) });
        }
        break;
      case "tool_call":
        {
          if (rawCallIds.has(toolCallKey(item))) {
            const text = `Tool ${item.name}: ${String(item.args)}`;
            if (assistant?.tool_calls?.length) {
              // No assistant message may intervene between native calls and their results.
              assistant.content = [assistant.content, text]
                .filter((part) => part !== null)
                .join("\n");
            } else {
              flushAssistant();
              messages.push({ role: "assistant", content: text });
            }
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
        if (rawCallIds.has(toolCallKey(item))) {
          rawResults.push({ role: "user", content: chatContent(item.content) });
        } else {
          const hasImages = item.content.some((block) => block.type === "image");
          messages.push({
            role: "tool",
            tool_call_id: item.callId,
            content:
              textOf(item.content) + (hasImages ? "\n[Images follow after tool results.]" : ""),
          });
          if (hasImages) {
            toolImages.push({ type: "text", text: `Images from tool result ${item.callId}:` });
            toolImages.push(...chatParts(item.content.filter((block) => block.type === "image")));
          }
        }
        break;
      case "compaction":
        flushAssistant();
        messages.push({ role: "user", content: textOf(item.content) });
        break;
      case "context":
        flushAssistant();
        contextNotices.push({ role: "user", content: textOf(item.content) });
        break;
    }
  }
  flushAssistant();
  flushDeferredResults();

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
