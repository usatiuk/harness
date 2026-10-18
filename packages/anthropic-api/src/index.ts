import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicCredentials } from "@harness/anthropic-core";

export interface ApiKeyOptions {
  apiKey: string;
  baseURL?: string;
}

/** Credentials backed by a single API-key client. */
export function apiKeyCredentials(opts: ApiKeyOptions): AnthropicCredentials {
  // The model-retry middleware owns logical retries; SDK-internal retries would
  // multiply attempts (and their Retry-After sleeps) beneath it.
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    maxRetries: 0,
  });
  return { client: () => Promise.resolve(client) };
}

export * from "./provider-type.ts";
