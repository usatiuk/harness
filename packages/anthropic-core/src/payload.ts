import type { ProviderPayload, ProviderPayloadDraft } from "@harness/protocol";

const THINKING_PAYLOAD_TYPE = "thinking";
const THINKING_PAYLOAD_VERSION = 1;

/**
 * The opaque blob we must round-trip to replay a thinking block statelessly. A `thinking`
 * block replays with its signature unchanged (the API validates it); a `redacted_thinking`
 * block replays its encrypted `data` verbatim. Both are bound to the issuing model: the
 * provider/model gate below is exactly Anthropic's "a different model drops thinking" rule.
 */
export type ThinkingPayload =
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string };

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
