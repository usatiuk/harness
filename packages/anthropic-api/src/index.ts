import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicCredentials } from "@harness/anthropic-core";

export interface ApiKeyOptions {
  apiKey: string;
  baseURL?: string;
}

/** Credentials backed by a single API-key client. */
export function apiKeyCredentials(opts: ApiKeyOptions): AnthropicCredentials {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  return { client: () => Promise.resolve(client) };
}

export * from "./provider-type.ts";
