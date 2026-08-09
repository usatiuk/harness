import type { Plugin } from "@harness/protocol";
import { apiKeyCredentials as openaiApiKeyCredentials } from "@harness/openai-api";
import { apiKeyCredentials as anthropicApiKeyCredentials } from "@harness/anthropic-api";
import { OpenCodeGoProvider } from "./provider.ts";

/** The Go gateway's shared API root (OpenAI client includes `/v1`; Anthropic needs the server root). */
export const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";
const ANTHROPIC_BASE = "https://opencode.ai/zen/go";

/** Registers the API-key-authenticated OpenCode Go provider across all three transports. */
export function createOpenCodeGoPlugin(opts: { apiKey: string }): Plugin {
  const openai = openaiApiKeyCredentials({ apiKey: opts.apiKey, baseURL: OPENCODE_GO_BASE });
  // The Anthropic SDK appends `/v1/messages`, so its baseURL is the server root.
  const anthropic = anthropicApiKeyCredentials({ apiKey: opts.apiKey, baseURL: ANTHROPIC_BASE });
  return {
    id: "opencode-go",
    providers: () => [new OpenCodeGoProvider({ openai, anthropic })],
  };
}
