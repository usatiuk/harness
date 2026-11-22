import type OpenAI from "openai";
import { z } from "zod";
import type { Item, ProviderPayload, ProviderPayloadDraft } from "@harness/protocol";
import { jsonValueSchema } from "@harness/protocol";

// Older transcripts kept only the native ID and ciphertext.
const legacyReasoning = z.object({ id: z.string(), encryptedContent: z.string().min(1) });

export function plaintextReasoning(item: OpenAI.Responses.ResponseReasoningItem) {
  return item.content?.some((part) => part.type === "reasoning_text" && part.text)
    ? item.content
    : undefined;
}

export function encodeOutputPayload(
  item: OpenAI.Responses.ResponseOutputMessage | OpenAI.Responses.ResponseReasoningItem,
  provider: string,
  model: string,
): ProviderPayloadDraft {
  return {
    provider,
    model,
    type: "response_output",
    version: 1,
    payload: jsonValueSchema.parse(item),
  };
}

/** Decode only the issuing Responses adapter's output. Legacy encrypted records remain readable. */
export function replayResponseOutput(
  item: Extract<Item, { type: "message" | "reasoning" }>,
  payload: ProviderPayload | undefined,
  provider: string,
  model: string,
): OpenAI.Responses.ResponseOutputMessage | OpenAI.Responses.ResponseReasoningItem | undefined {
  if (payload?.provider !== provider || payload.model !== model) return;
  if (payload.type !== "reasoning" && payload.type !== "response_output") return;
  if (payload.version !== 1) {
    if (item.type === "reasoning")
      throw new Error("Saved reasoning payload version is not supported");
    return;
  }
  const native = payload.payload;
  if (payload.type === "reasoning") {
    if (item.type !== "reasoning") return;
    const { id, encryptedContent } = legacyReasoning.parse(native);
    return {
      type: "reasoning",
      id,
      encrypted_content: encryptedContent,
      summary: item.content.flatMap((block) =>
        block.type === "text" ? [{ type: "summary_text", text: block.text }] : [],
      ),
    };
  }
  if (!native || typeof native !== "object" || !("type" in native) || native.type !== item.type)
    return;
  if (item.type === "message" && item.role === "assistant")
    return native as OpenAI.Responses.ResponseOutputMessage;
  if (item.type === "reasoning") {
    const reasoning = native as OpenAI.Responses.ResponseReasoningItem;
    if (reasoning.encrypted_content || plaintextReasoning(reasoning)) return reasoning;
  }
}
