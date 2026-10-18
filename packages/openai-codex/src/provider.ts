import OpenAI from "openai";
import { z } from "zod";
import {
  OPENAI_MODELS,
  OpenAIResponsesProvider,
  openAIModelConfigSchema,
  type OpenAICredentials,
  type OpenAIModelSpec,
  type OpenAIModelConfig,
} from "@harness/openai-core";
import { ModelDiscoveryError } from "@harness/protocol";
import { PRODUCT_VERSION } from "@harness/release";
import type { CodexAuth } from "./auth.ts";
import { codexCredentials } from "./credentials.ts";

export const CODEX_PROVIDER = "openai-codex";

// ChatGPT roster and Codex effort controls verified 2026-10-03; capacity assumptions below.
// Ultra is Codex orchestration, not an effort supported by a Harness model invocation.
const CODEX_MODELS = OPENAI_MODELS.filter(
  (model) =>
    model.model.startsWith("gpt-6") ||
    model.model.startsWith("gpt-5.6") ||
    model.model === "gpt-5.5",
).map((model) => ({
  model: model.model,
  customToolInput: { supported: true, grammars: ["lark"] as ("lark" | "regex")[] },
  preferredEditTool: "patch" as const,
  ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  // Operational ceilings inferred from Codex's working budgets plus the output reserve.
  // These are assumptions, not verified backend limits; combined context remains unknown.
  maxInputTokens: model.model === "gpt-6.1-sol" ? 628_000 : 400_000,
  ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
  presets: model.presets.filter((entry) => entry.value !== "none"),
  defaultPreset: model.model === "gpt-6.1-sol" || model.model === "gpt-5.6-sol" ? "low" : "medium",
}));

// Consume only native controls mapped directly onto Harness editing and effort selection.
const catalogSchema = z.object({
  models: z
    .array(
      z.object({
        slug: z.string().min(1).max(512),
        apply_patch_tool_type: z.enum(["freeform"]).nullish(),
        supported_reasoning_levels: z
          .array(
            z.object({
              effort: openAIModelConfigSchema.shape.defaultPreset.unwrap(),
              description: z.string().optional(),
            }),
          )
          .optional(),
        default_reasoning_level: openAIModelConfigSchema.shape.defaultPreset.unwrap().optional(),
      }),
    )
    .max(5000),
});

// The SDK wraps any fetch exception, including programming defects, as a
// connection error. Recover only recognized Node transport failures.
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);
function networkFailure(error: unknown): boolean {
  const failure = error instanceof OpenAI.APIConnectionError ? error.cause : error;
  const cause = failure instanceof Error ? failure.cause : undefined;
  return cause instanceof Error && "code" in cause && NETWORK_CODES.has(String(cause.code));
}
function abortedOperation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason ||
      error instanceof OpenAI.APIUserAbortError ||
      (error instanceof DOMException && error.name === "AbortError"))
  );
}

class CodexProvider extends OpenAIResponsesProvider {
  readonly #credentials: OpenAICredentials;

  constructor(
    auth: CodexAuth,
    provider: string,
    webSearch: boolean,
    modelOverrides: Record<string, OpenAIModelConfig>,
  ) {
    const credentials = codexCredentials(auth);
    super({
      provider,
      webSearch,
      credentials,
      models: CODEX_MODELS,
      modelOverrides,
      supportsMaxOutputTokens: false,
    });
    this.#credentials = credentials;
  }

  async refreshModels(signal: AbortSignal) {
    // Keep the streaming client's detail surfacing unchanged. Catalog failures
    // must retain their HTTP status for standard discovery classification.
    const client = (await this.#credentials.client(signal)).withOptions({
      fetch: globalThis.fetch,
    });
    let response: Response;
    try {
      response = await client
        .get("/models", {
          query: { client_version: PRODUCT_VERSION },
          signal,
          maxRetries: 0,
        })
        .asResponse();
    } catch (error) {
      if (abortedOperation(error, signal)) signal.throwIfAborted();
      if (error instanceof OpenAI.APIConnectionTimeoutError)
        throw new ModelDiscoveryError("timeout", "Codex catalog request timed out");
      if (networkFailure(error))
        throw new ModelDiscoveryError(
          "network",
          "Codex catalog request could not reach the server",
        );
      if (error instanceof OpenAI.APIError && typeof error.status === "number")
        throw new ModelDiscoveryError("http", "Codex catalog request failed", error.status);
      throw error;
    }
    signal.throwIfAborted();
    if (!response.body)
      throw new ModelDiscoveryError("invalid-response", "Codex catalog response has no body");
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024)
          throw new ModelDiscoveryError("limit", "Codex catalog response exceeds 2 MiB");
        chunks.push(chunk.value);
      }
    } catch (error) {
      // Cancelling an already errored body can itself reject; preserve the
      // original read failure rather than replacing it with cleanup failure.
      await reader.cancel().catch(() => undefined);
      if (abortedOperation(error, signal)) signal.throwIfAborted();
      if (!networkFailure(error)) throw error;
      throw new ModelDiscoveryError("network", "Codex catalog response was interrupted");
    } finally {
      reader.releaseLock();
    }
    signal.throwIfAborted();
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ModelDiscoveryError("invalid-response", "Codex catalog response is not valid JSON");
    }
    const parsed = catalogSchema.safeParse(raw);
    if (!parsed.success)
      throw new ModelDiscoveryError("invalid-response", "Codex catalog has an invalid model array");
    const entries = new Map<string, OpenAIModelSpec>();
    for (const model of parsed.data.models) {
      if (entries.has(model.slug))
        throw new ModelDiscoveryError("invalid-response", "Codex catalog has duplicate model IDs");
      const baseline = CODEX_MODELS.find((entry) => entry.model === model.slug);
      const entry: OpenAIModelSpec = {
        ...(baseline ?? { model: model.slug, presets: [] }),
        ...(model.apply_patch_tool_type === "freeform" ? { preferredEditTool: "patch" } : {}),
      };
      if (model.supported_reasoning_levels) {
        entry.presets = model.supported_reasoning_levels.map(({ effort }) => ({ value: effort }));
        if (!entry.presets.some(({ value }) => value === entry.defaultPreset))
          delete entry.defaultPreset;
      }
      if (model.default_reasoning_level) entry.defaultPreset = model.default_reasoning_level;
      if (
        entry.defaultPreset &&
        !entry.presets.some(({ value }) => value === entry.defaultPreset)
      ) {
        throw new ModelDiscoveryError(
          "invalid-response",
          "Codex default effort is not offered by the model",
        );
      }
      entries.set(model.slug, entry);
    }
    // Discovery owns the advertised roster; explicit config additions and
    // overrides are applied by the shared provider after each refresh.
    this.replaceModels([...entries.values()]);
    return { status: "ready" as const, diagnostics: [] };
  }
}

/** A subscription connection with Codex-specific capacity and request policy. */
export function createCodexProvider(
  auth: CodexAuth,
  provider: string,
  webSearch = false,
  modelOverrides: Record<string, OpenAIModelConfig> = {},
): CodexProvider {
  return new CodexProvider(auth, provider, webSearch, modelOverrides);
}
