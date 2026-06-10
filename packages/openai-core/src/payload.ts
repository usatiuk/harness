import type OpenAI from "openai";
import type { ProviderPayload, ProviderPayloadDraft } from "@harness/protocol";

const REASONING_PAYLOAD_TYPE = "reasoning";
const REASONING_PAYLOAD_VERSION = 1;

/** The opaque blob we must round-trip to replay a reasoning item statelessly. */
interface ReasoningPayload {
  id: string;
  encryptedContent: string;
}

/**
 * Encodes a reasoning item's `encrypted_content`; `undefined` when there is none. Tagged with
 * the live provider id: encrypted reasoning is bound to the backend that issued it, so the tag
 * (not just the model) gates replay.
 */
export function encodeReasoningPayload(
  item: OpenAI.Responses.ResponseReasoningItem,
  provider: string,
  model: string,
): ProviderPayloadDraft | undefined {
  if (!item.encrypted_content) return undefined;
  const payload: ReasoningPayload = { id: item.id, encryptedContent: item.encrypted_content };
  return {
    provider,
    model,
    type: REASONING_PAYLOAD_TYPE,
    version: REASONING_PAYLOAD_VERSION,
    payload,
  };
}

/** Reads a reasoning payload; `undefined` unless provider/model/type/version all match. */
export function readReasoningPayload(
  payload: ProviderPayload | undefined,
  currentProvider: string,
  currentModel: string,
): ReasoningPayload | undefined {
  if (
    !payload ||
    payload.provider !== currentProvider ||
    payload.model !== currentModel ||
    payload.type !== REASONING_PAYLOAD_TYPE ||
    payload.version !== REASONING_PAYLOAD_VERSION
  ) {
    return undefined;
  }
  return payload.payload as ReasoningPayload;
}
