import Anthropic from "@anthropic-ai/sdk";
import type { Plugin } from "@harness/protocol";
import { AnthropicProvider, type AnthropicCredentials } from "@harness/anthropic-core";

export interface AnthropicPluginOptions {
  apiKey: string;
  baseURL?: string;
}

/** Credentials backed by a single API-key client. */
export function apiKeyCredentials(opts: AnthropicPluginOptions): AnthropicCredentials {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  return { client: () => Promise.resolve(client) };
}

/**
 * Registers the API-key-authenticated Anthropic Messages provider. Model capabilities select a
 * familiar file-tool dialect, but the workspace plugin owns and executes that tool roster.
 */
export function createAnthropicPlugin(opts: AnthropicPluginOptions): Plugin {
  const credentials = apiKeyCredentials(opts);
  return {
    id: "anthropic-api",
    providers: () => [new AnthropicProvider({ credentials })],
  };
}
