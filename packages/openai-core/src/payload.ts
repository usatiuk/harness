import type OpenAI from "openai";
import type { ProviderPayload, ProviderPayloadDraft } from "@harness/protocol";

export const OPENAI_PROVIDER = "openai";
const REASONING_PAYLOAD_TYPE = "reasoning";
const REASONING_PAYLOAD_VERSION = 1;

/** The opaque blob we must round-trip to replay a reasoning item statelessly. */
interface ReasoningPayload {
  id: string;
  encryptedContent: string;
}

/** Encodes a reasoning item's `encrypted_content`; `undefined` when there is none. */
export function encodeReasoningPayload(
  item: OpenAI.Responses.ResponseReasoningItem,
  model: string,
): ProviderPayloadDraft | undefined {
  if (!item.encrypted_content) return undefined;
  const payload: ReasoningPayload = { id: item.id, encryptedContent: item.encrypted_content };
  return {
    provider: OPENAI_PROVIDER,
    model,
    type: REASONING_PAYLOAD_TYPE,
    version: REASONING_PAYLOAD_VERSION,
    payload,
  };
}

/** Reads a reasoning payload; `undefined` unless it is ours and the version matches. */
export function readReasoningPayload(payload?: ProviderPayload): ReasoningPayload | undefined {
  if (
    !payload ||
    payload.provider !== OPENAI_PROVIDER ||
    payload.type !== REASONING_PAYLOAD_TYPE ||
    payload.version !== REASONING_PAYLOAD_VERSION
  ) {
    return undefined;
  }
  return payload.payload as ReasoningPayload;
}
