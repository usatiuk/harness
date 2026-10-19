import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  asShape,
  messageOf,
  retryAfterMsFromHeaders,
  TransientModelFailure,
} from "@harness/protocol";
import {
  classifyTransientFailure as classifyOpenAI,
  isPermanentQuotaFailure,
} from "@harness/openai-core";
import { classifyTransientFailure as classifyAnthropic } from "@harness/anthropic-core";

/** Gateway policy sees the raw error before either shared SDK transport normalizes it. */
export function classifyTransientFailure(
  error: unknown,
  signal?: AbortSignal,
): TransientModelFailure | undefined {
  if (
    signal?.aborted ||
    error instanceof TransientModelFailure ||
    error instanceof OpenAI.APIUserAbortError ||
    error instanceof Anthropic.APIUserAbortError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    isPermanentQuotaFailure(error)
  )
    return undefined;

  const failure =
    error instanceof Anthropic.APIError
      ? classifyAnthropic(error, signal)
      : classifyOpenAI(error, signal);
  if (failure) return failure;

  // Go additionally treats unenumerated 5xx gateway statuses as transient.
  const { status } = asShape(error);
  if (!(typeof status === "number" && status >= 500 && status <= 599)) return undefined;
  const message = messageOf(error);
  const retryAfterMs = retryAfterMsFromHeaders(error);
  return new TransientModelFailure("server", {
    cause: error,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
