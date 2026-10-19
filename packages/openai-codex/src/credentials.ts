import OpenAI from "openai";
import type { OpenAICredentials } from "@harness/openai-core";
import type { CodexAuth } from "./auth.ts";
import { CODEX_API_BASE_URL, CODEX_ORIGINATOR } from "./oauth.ts";

/**
 * The Codex backend reports errors as `{"detail": "..."}`, which the OpenAI SDK can't read
 * (it looks for `error.message`). Normalize only that HTTP error body, keeping machine
 * fields and HTTP metadata so the SDK does not mistake a rejection for a transport failure.
 */
const surfacingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.ok) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    // non-JSON error body — let the SDK handle it
    return res;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("detail" in body) ||
    typeof body.detail !== "string" ||
    body.detail.length === 0
  )
    return res;
  const { error } = body as Record<string, unknown>;
  const headers = new Headers(res.headers);
  // Fetch has already decoded the body; these describe the replaced wire bytes.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return Response.json(
    {
      ...body,
      error: {
        ...(typeof error === "object" && error !== null ? error : {}),
        // Retain the original nested error as well as top-level machine fields.
        // Neither may hide the other's permanent billing/quota signal.
        ...body,
        message: body.detail,
      },
    },
    { status: res.status, statusText: res.statusText, headers },
  );
};

/**
 * `OpenAICredentials` that mint a client pointed at the Codex backend, authenticated with the
 * subscription access token. Built per call after a (possibly refreshed) valid session.
 */
export function codexCredentials(auth: CodexAuth): OpenAICredentials {
  return {
    client: async (signal) => {
      const session = await auth.getValidSession({ signal });
      return new OpenAI({
        apiKey: session.accessToken,
        baseURL: CODEX_API_BASE_URL,
        fetch: surfacingFetch,
        // The model-retry middleware owns logical retries; SDK-internal retries
        // would multiply attempts beneath it (belt over the per-request pin).
        maxRetries: 0,
        defaultHeaders: {
          "ChatGPT-Account-ID": session.accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: CODEX_ORIGINATOR,
        },
      });
    },
  };
}
