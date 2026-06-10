import OpenAI from "openai";
import type { OpenAICredentials } from "@harness/openai-core";
import type { CodexAuth } from "./auth.ts";
import { CODEX_API_BASE_URL, CODEX_ORIGINATOR } from "./oauth.ts";

/**
 * The Codex backend reports errors as `{"detail": "..."}`, which the OpenAI SDK can't read
 * (it looks for `error.message`) — surfacing only "400 status code (no body)". Lift `detail`
 * off a failed response and throw it; everything else passes through to the SDK.
 */
const surfacingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.ok) return res;
  let detail: string | undefined;
  try {
    const body = (await res.clone().json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // non-JSON error body — let the SDK handle it
  }
  if (detail) throw new Error(`Codex request failed (${res.status}): ${detail}`);
  return res;
};

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
        fetch: surfacingFetch,
        defaultHeaders: {
          "ChatGPT-Account-ID": session.accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: CODEX_ORIGINATOR,
        },
      });
    },
  };
}
