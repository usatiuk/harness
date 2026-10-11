import type { ProviderPayload, ProviderPayloadDraft } from "@harness/protocol";
import type Anthropic from "@anthropic-ai/sdk";
import { jsonValueSchema } from "@harness/protocol";

/** Only completed search pairs belong in finalized or selected assistant history. */
export function completedSearchFilter(
  blocks: readonly (Anthropic.Messages.ContentBlock | Anthropic.Messages.ContentBlockParam)[],
): (block: Anthropic.Messages.ContentBlock | Anthropic.Messages.ContentBlockParam) => boolean {
  const calls = new Set(
    blocks.flatMap((block) => (block.type === "server_tool_use" ? [block.id] : [])),
  );
  const results = new Set(
    blocks.flatMap((block) => (block.type === "web_search_tool_result" ? [block.tool_use_id] : [])),
  );
  return (block) =>
    block.type === "server_tool_use"
      ? results.has(block.id)
      : block.type === "web_search_tool_result"
        ? calls.has(block.tool_use_id)
        : true;
}

export function encodeBlockPayload(
  blocks: Anthropic.Messages.ContentBlock[],
  provider: string,
  model: string,
): ProviderPayloadDraft {
  return {
    provider,
    model,
    type: "message_blocks",
    version: 1,
    payload: jsonValueSchema.parse(blocks),
  };
}

export function readBlockPayload(
  payload: ProviderPayload | undefined,
  provider: string,
  model: string,
): Anthropic.Messages.ContentBlockParam[] | undefined {
  return payload?.provider === provider &&
    payload.model === model &&
    payload.type === "message_blocks" &&
    payload.version === 1
    ? (structuredClone(payload.payload) as Anthropic.Messages.ContentBlockParam[])
    : undefined;
}

const THINKING_PAYLOAD_TYPE = "thinking";
const THINKING_PAYLOAD_VERSION = 1;

/**
 * The opaque blob we must round-trip to replay a thinking block statelessly. A `thinking`
 * block replays with its signature unchanged (the API validates it); a `redacted_thinking`
 * block replays its encrypted `data` verbatim. Both are bound to the issuing model: the
 * provider/model gate below is exactly Anthropic's "a different model drops thinking" rule.
 */
export type ThinkingPayload =
  { kind: "thinking"; thinking: string; signature: string } | { kind: "redacted"; data: string };

/** Tags a finalized thinking payload with the live provider/model so replay can be gated. */
export function encodeThinkingPayload(
  thinking: ThinkingPayload,
  provider: string,
  model: string,
): ProviderPayloadDraft {
  return {
    provider,
    model,
    type: THINKING_PAYLOAD_TYPE,
    version: THINKING_PAYLOAD_VERSION,
    payload: thinking,
  };
}

/** Reads a thinking payload; `undefined` unless provider/model/type/version all match. */
export function readThinkingPayload(
  payload: ProviderPayload | undefined,
  currentProvider: string,
  currentModel: string,
): ThinkingPayload | undefined {
  if (
    !payload ||
    payload.provider !== currentProvider ||
    payload.model !== currentModel ||
    payload.type !== THINKING_PAYLOAD_TYPE ||
    payload.version !== THINKING_PAYLOAD_VERSION
  ) {
    return undefined;
  }
  return payload.payload as ThinkingPayload;
}
