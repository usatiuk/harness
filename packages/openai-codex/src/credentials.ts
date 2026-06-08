import OpenAI from "openai";
import type { OpenAICredentials } from "@harness/openai-core";
import type { CodexAuth } from "./auth.ts";
import { CODEX_API_BASE_URL, CODEX_ORIGINATOR } from "./oauth.ts";

/**
 * `OpenAICredentials` that mint a client pointed at the Codex backend, authenticated with the
 * subscription access token. Built per call after a (possibly refreshed) valid session.
 */
export function codexCredentials(auth: CodexAuth): OpenAICredentials {
  return {
    client: async () => {
      const session = await auth.getValidSession();
      return new OpenAI({
        apiKey: session.accessToken,
        baseURL: CODEX_API_BASE_URL,
        defaultHeaders: {
          "ChatGPT-Account-ID": session.accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: CODEX_ORIGINATOR,
        },
      });
    },
  };
}
