import type { Plugin } from "@harness/protocol";
import { OpenAIResponsesProvider } from "@harness/openai-core";
import type { CodexAuth } from "./auth.ts";
import { codexCredentials } from "./credentials.ts";

export const CODEX_PROVIDER = "openai-codex";

/** Registers the Codex (ChatGPT subscription) Responses provider, authenticated via OAuth. */
export function codexPlugin(auth: CodexAuth, opts: { nativeTools?: boolean } = {}): Plugin {
  return {
    id: CODEX_PROVIDER,
    providers: () => [
      new OpenAIResponsesProvider({
        provider: CODEX_PROVIDER,
        credentials: codexCredentials(auth),
        ...(opts.nativeTools !== undefined ? { nativeTools: opts.nativeTools } : {}),
      }),
    ],
  };
}
