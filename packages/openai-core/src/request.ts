import type OpenAI from "openai";
import type {
  ContentBlock,
  Item,
  ModelRequest,
  ProviderPayload,
  ToolSchema,
} from "@harness/protocol";
import { readReasoningPayload } from "./payload.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * Loose view of an assistant message carrying the untyped `reasoning_content`
 * field that chat backends use for plaintext chain-of-thought round-trip.
 */
type ChatMessageWithReasoning = ChatMessage & { reasoning_content?: string };

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
  payload?: ProviderPayload,
): InputItem | undefined {
  switch (item.type) {
    case "message":
      return { role: item.role, content: textOf(item.content) };
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
      // A freeform tool's canonical args are the raw input string; round-trip it natively.
      if (freeformCallIds.has(item.callId)) {
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
      if (freeformCallIds.has(item.callId)) {
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
  reasoning: OpenAI.Reasoning,
  provider: string,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  // Freeform tools round-trip as `custom_tool_call` items. A tool_result carries only its
  // callId, so pre-scan the calls to know which results render as custom output.
  const freeformNames = new Set(
    request.tools?.filter((t) => t.kind === "custom").map((t) => t.name) ?? [],
  );
  const freeformCallIds = new Set<string>();
  for (const { item } of request.items) {
    if (item.type === "tool_call" && freeformNames.has(item.name)) freeformCallIds.add(item.callId);
  }

  const input: InputItem[] = [];
  for (const { item, payload } of request.items) {
    const mapped = toInputItem(item, provider, request.modelConfig.model, freeformCallIds, payload);
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

  return {
    model: request.modelConfig.model,
    instructions: textOf(request.instructions),
    input,
    stream: true,
    store: false, // stateless: we own the log and round-trip reasoning via encrypted_content
    include: ["reasoning.encrypted_content"],
    reasoning,
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
 * plaintext `reasoning_content` on the assistant message that follows it, and
 * instructions + context render as a single leading system message.
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
  // A preceding `reasoning` item merges into the assistant output that follows
  // it; `undefined` once merged or when no reasoning is pending.
  let pendingReasoning: string | undefined;

  for (const { item } of request.items) {
    switch (item.type) {
      case "message":
        // A plugin-appended system message would create a second system message,
        // which chat backends reject; fail fast rather than emit it.
        if (item.role === "system") {
          throw new Error(
            "chat transport emits at most one system message; a system-role message item is not allowed",
          );
        }
        {
          // `reasoning_content` is an assistant-only field. A non-assistant
          // message after a pending reasoning item (e.g. the user's next steer
          // after a reasoning-only turn) must not absorb it — flush the reasoning
          // as a standalone assistant message instead.
          if (item.role !== "assistant" && pendingReasoning !== undefined) {
            const standalone: ChatMessageWithReasoning = {
              role: "assistant",
              content: null,
              reasoning_content: pendingReasoning,
            };
            messages.push(standalone);
            pendingReasoning = undefined;
          }
          const message: ChatMessageWithReasoning = {
            role: item.role,
            content: textOf(item.content),
          };
          if (pendingReasoning !== undefined) {
            message.reasoning_content = pendingReasoning;
            pendingReasoning = undefined;
          }
          messages.push(message);
        }
        break;
      case "reasoning":
        // Plaintext round-trip: no encrypted_content, no signature. The text rides
        // the assistant message that follows, or a standalone message at turn end.
        pendingReasoning = textOf(item.content);
        break;
      case "tool_call":
        {
          const message: ChatMessageWithReasoning = {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: item.callId,
                type: "function",
                function: {
                  name: item.name,
                  arguments: JSON.stringify(item.args),
                },
              },
            ],
          };
          if (pendingReasoning !== undefined) {
            message.reasoning_content = pendingReasoning;
            pendingReasoning = undefined;
          }
          messages.push(message);
        }
        break;
      case "tool_result":
        // tool_result.status is not transmitted — same as the Responses transport.
        messages.push({ role: "tool", tool_call_id: item.callId, content: textOf(item.content) });
        break;
      case "compaction":
        messages.push({ role: "user", content: textOf(item.content) });
        break;
      case "context":
        contextTexts.push(textOf(item.content));
        break;
    }
  }

  // A reasoning item with no following assistant output still round-trips as a
  // standalone assistant message carrying the plaintext reasoning.
  if (pendingReasoning !== undefined) {
    const standalone: ChatMessageWithReasoning = {
      role: "assistant",
      content: null,
      reasoning_content: pendingReasoning,
    };
    messages.push(standalone);
  }

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
