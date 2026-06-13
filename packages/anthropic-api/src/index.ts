import Anthropic from "@anthropic-ai/sdk";
import type { Plugin } from "@harness/protocol";
import { AnthropicProvider, type AnthropicCredentials } from "@harness/anthropic-core";
import { TextEditorTool } from "./text-editor.ts";

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
 * `text_editor` profile, Claude's native file editor. The editor lives here (not in workspace)
 * because it's a provider built-in declared via the `native` tool arm.
 */
export function createAnthropicPlugin(opts: AnthropicPluginOptions): Plugin {
  const credentials = apiKeyCredentials(opts);
  return {
    id: "anthropic-api",
    providers: () => [new AnthropicProvider({ credentials })],
    tools: (caps) => (caps.fileTools === "text_editor" ? [new TextEditorTool()] : []),
  };
}
