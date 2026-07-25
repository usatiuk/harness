import Anthropic from "@anthropic-ai/sdk";
import type { Plugin } from "@harness/protocol";
import { AnthropicProvider, type AnthropicCredentials } from "@harness/anthropic-core";
import { executionServiceOf } from "@harness/execution";
import { executionTextEditorTool } from "./text-editor.ts";

export { TextEditorTool } from "./text-editor.ts";

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
 * Registers the API-key-authenticated Anthropic Messages provider and, for models on the
 * `text_editor` profile, Harness's schema-compatible Claude-style editor. The editor lives here
 * because its model-facing command contract is provider-specific even though Harness executes it.
 */
export function createAnthropicPlugin(opts: AnthropicPluginOptions): Plugin {
  const credentials = apiKeyCredentials(opts);
  return {
    id: "anthropic-api",
    providers: () => [new AnthropicProvider({ credentials })],
    tools: (caps, ctx) =>
      caps.fileTools === "text_editor" ? [executionTextEditorTool(executionServiceOf(ctx))] : [],
  };
}
