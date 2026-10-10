import { z } from "zod";
import { PRODUCT_USER_AGENT } from "@harness/release";
import { ModelDiscoveryError, type ModelInfo } from "@harness/protocol";

export type MistralMode = "api" | "vibe";
export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const MAX_MODELS = 5000;
// Node fetch reports transport failures through a coded cause. An arbitrary
// TypeError is a programming defect, even if cancellation races it.
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
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && "code" in cause && NETWORK_CODES.has(String(cause.code));
}
function abortedOperation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || (error instanceof DOMException && error.name === "AbortError"))
  );
}
const id = z.string().min(1).max(512);
const capacity = z.number().int().positive().nullish();
const temperature = z.number().min(0).max(2).nullish();
const capabilities = z.object({
  completion_chat: z.boolean().optional(),
  function_calling: z.boolean(),
  vision: z.boolean().optional(),
});
const common = {
  id,
  aliases: z.array(id).max(MAX_MODELS).default([]),
  max_context_length: capacity,
  capabilities,
};
const apiEntry = z.object({
  ...common,
  name: z.string().min(1).max(512).nullish(),
  default_model_temperature: temperature,
});
const vibeEntry = z.object({
  ...common,
  label: z.string().min(1).max(512),
  parameters: z
    .object({
      temperature,
      reasoning: z.array(z.string().min(1).max(32)).max(32).nullish(),
    })
    .nullish(),
});

// Vibe's controls deliberately collapse onto the native none/high choices.
export const REASONING_EFFORT = {
  off: "none",
  low: "none",
  medium: "high",
  high: "high",
  max: "high",
} as const;
export type ReasoningPreset = keyof typeof REASONING_EFFORT;
export interface CatalogEntry {
  info: ModelInfo;
  temperature?: number;
}

export function parseCatalog(raw: unknown, mode: MistralMode, provider: string) {
  const envelope = z
    .object({
      [mode === "api" ? "data" : "models"]: z.array(z.unknown()).max(MAX_MODELS),
    })
    .safeParse(raw);
  if (!envelope.success)
    throw new ModelDiscoveryError("invalid-response", "Mistral catalog has an invalid model array");
  const rows = envelope.data[mode === "api" ? "data" : "models"]!;
  const entries = new Map<string, CatalogEntry>();
  const diagnostics: string[] = [];
  const explicitIds = new Set<string>();
  const models: (z.infer<typeof apiEntry> | z.infer<typeof vibeEntry>)[] = [];
  for (const row of rows) {
    const parsed = (mode === "api" ? apiEntry : vibeEntry).safeParse(row);
    if (!parsed.success) {
      diagnostics.push("Mistral catalog contains an invalid model entry");
      continue;
    }
    const model = parsed.data;
    if (explicitIds.has(model.id))
      throw new ModelDiscoveryError(
        "invalid-response",
        "Mistral catalog contains duplicate model IDs",
      );
    explicitIds.add(model.id);
    models.push(model);
  }
  for (const model of models) {
    if (model.capabilities.completion_chat === false || !model.capabilities.function_calling)
      continue;
    const params = "parameters" in model ? model.parameters : undefined;
    const levels = [...new Set(params?.reasoning ?? [])].filter((value): value is ReasoningPreset =>
      Object.hasOwn(REASONING_EFFORT, value),
    );
    if ((params?.reasoning ?? []).some((value) => !Object.hasOwn(REASONING_EFFORT, value)))
      diagnostics.push(`Model '${model.id}' advertises unsupported reasoning controls`);
    const sampling =
      params?.temperature ??
      ("default_model_temperature" in model ? model.default_model_temperature : undefined);
    const label = "label" in model ? model.label : model.name;
    for (const modelId of new Set([model.id, ...model.aliases])) {
      // An explicit row owns its ID, even when it declares an unsupported model.
      if (modelId !== model.id && explicitIds.has(modelId)) continue;
      if (entries.has(modelId))
        throw new ModelDiscoveryError(
          "invalid-response",
          "Mistral catalog contains conflicting aliases",
        );
      entries.set(modelId, {
        info: {
          provider,
          model: modelId,
          ...(label ? { label } : {}),
          ...(model.max_context_length != null ? { contextWindow: model.max_context_length } : {}),
          ...(levels.length
            ? {
                presets: levels.map((value) => ({ value })),
                reasoning: { supported: true, effortLevels: levels },
              }
            : {}),
        },
        ...(sampling != null ? { temperature: sampling } : {}),
      });
      if (entries.size > MAX_MODELS)
        throw new ModelDiscoveryError(
          "limit",
          "Mistral catalog exceeds 5000 models including aliases",
        );
    }
  }
  // A malformed nonempty response must not erase a working catalog.
  if (rows.length && !entries.size && diagnostics.length)
    throw new ModelDiscoveryError(
      "invalid-response",
      "Mistral catalog contains no valid model entries",
    );
  return { entries, diagnostics: diagnostics.slice(0, 20) };
}

export async function fetchCatalog(
  mode: MistralMode,
  apiKey: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<unknown> {
  signal.throwIfAborted();
  const path = mode === "api" ? "/models" : "/model-catalog?surface=vibe-code";
  let response: Response;
  try {
    response = await fetcher(`${MISTRAL_BASE_URL}${path}`, {
      headers: { authorization: `Bearer ${apiKey}`, "user-agent": PRODUCT_USER_AGENT },
      signal,
      redirect: "manual",
    });
  } catch (error) {
    if (abortedOperation(error, signal)) signal.throwIfAborted();
    if (!networkFailure(error)) throw error;
    throw new ModelDiscoveryError("network", "Mistral catalog request could not reach the server");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelDiscoveryError(
      "http",
      `Mistral catalog returned HTTP ${response.status}`,
      response.status,
    );
  }
  if (!response.body)
    throw new ModelDiscoveryError("invalid-response", "Mistral catalog response has no body");
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new ModelDiscoveryError("limit", "Mistral catalog response exceeds 2 MiB");
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (abortedOperation(error, signal)) signal.throwIfAborted();
    if (error instanceof ModelDiscoveryError) throw error;
    if (!networkFailure(error)) throw error;
    throw new ModelDiscoveryError("network", "Mistral catalog response was interrupted");
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new ModelDiscoveryError("invalid-response", "Mistral catalog response is not valid JSON");
  }
}
