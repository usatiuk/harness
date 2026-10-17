import { z } from "zod";
import { ModelDiscoveryError, type ModelReasoningInfo } from "@harness/protocol";
import { PRODUCT_USER_AGENT } from "@harness/release";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const GO_OPENAI_BASE = "https://opencode.ai/inference/go/openai/v1";
export const GO_ANTHROPIC_BASE = "https://opencode.ai/inference/go/anthropic";

export type GoFamily = "chat" | "responses" | "messages";
export type GoPresetControl =
  | { kind: "effort"; effort: string }
  | { kind: "thinking"; thinking: "disabled" | "adaptive" }
  | { kind: "thinking-budget"; budgetTokens: number };
export interface GoPresetSpec {
  value: string;
  label?: string;
  control: GoPresetControl;
}
export interface GoModelSpec {
  model: string;
  label?: string;
  family: GoFamily;
  contextWindow: number;
  maxOutputTokens: number;
  maxInputTokens?: number;
  reasoning?: ModelReasoningInfo;
  supportsImages?: boolean;
  presets?: GoPresetSpec[];
  defaultPreset?: string;
}

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:/-]+$/);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const routing = z.object({ npm: z.string().optional(), api: z.string().optional() });
const row = z.object({
  id,
  name: z.string().min(1).max(256).optional(),
  limit: z.object({ context: count, output: count, input: count.optional() }),
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(
      z.object({
        type: z.string().max(64),
        values: z.array(z.string().min(1).max(32)).max(32).optional(),
        max: count.optional(),
      }),
    )
    .max(32)
    .optional(),
  tool_call: z.boolean(),
  modalities: z.object({ input: z.array(z.string()).max(32).optional() }).optional(),
  status: z.string().optional(),
  provider: routing.optional(),
});
const catalog = z.object({
  "opencode-go": routing.extend({ models: z.record(id, z.unknown()) }),
});

/** Transport is protocol policy, not the upstream model's marketing family. */
function familyFor(npm: string | undefined, api: string | undefined): GoFamily | undefined {
  // The Go endpoints table maps @ai-sdk/openai to Responses, while
  // @ai-sdk/openai-compatible selects Chat Completions. Marketing names do not
  // determine protocol. Never turn upstream endpoint strings into destinations.
  if (api === `${GO_ANTHROPIC_BASE}/v1`)
    return npm === "@ai-sdk/anthropic" ? "messages" : undefined;
  if (api !== GO_OPENAI_BASE) return undefined;
  if (npm === "@ai-sdk/openai") return "responses";
  return npm === "@ai-sdk/openai-compatible" ? "chat" : undefined;
}

function presetsFor(model: z.infer<typeof row>, family: GoFamily): GoPresetSpec[] {
  const options = model.reasoning_options ?? [];
  const effort = options.find((option) => option.type === "effort");
  if (family !== "messages")
    return (effort?.values ?? []).map((value) => ({
      value,
      control: { kind: "effort", effort: value },
    }));
  const budget = options.find((option) => option.type === "budget_tokens");
  if (budget) {
    // Preserve the established Go/OpenCode high/max budget controls, bounded by
    // both the advertised budget and output capacity. Messages needs budget < cap.
    const max = Math.min(32_000, budget.max ?? 32_000, model.limit.output) - 1;
    if (max < 1024) return [];
    return [
      {
        value: "high",
        control: {
          kind: "thinking-budget",
          budgetTokens: Math.max(1024, Math.floor((max + 1) / 2)),
        },
      },
      { value: "max", control: { kind: "thinking-budget", budgetTokens: max } },
    ];
  }
  if (model.id === "minimax-m3" && options.some((option) => option.type === "toggle"))
    return [
      { value: "none", label: "Thinking off", control: { kind: "thinking", thinking: "disabled" } },
      {
        value: "thinking",
        label: "Thinking on",
        control: { kind: "thinking", thinking: "adaptive" },
      },
    ];
  // A toggle/effort advertisement alone does not establish adaptive-vs-budgeted
  // Messages thinking. Leave unqualified controls to the gateway's native default.
  return [];
}

export function parseCatalog(value: unknown): { models: GoModelSpec[]; diagnostics: string[] } {
  const parsed = catalog.safeParse(value);
  if (!parsed.success)
    throw new ModelDiscoveryError("invalid-response", "Models.dev Go catalog is invalid");
  const provider = parsed.data["opencode-go"];
  const rows = Object.entries(provider.models);
  if (rows.length > 5000)
    throw new ModelDiscoveryError("limit", "Models.dev Go catalog exceeds 5000 models");
  const models: GoModelSpec[] = [];
  const diagnostics: string[] = [];
  const diagnostic = (message: string) => {
    if (diagnostics.length < 20) diagnostics.push(message);
  };
  for (const [key, raw] of rows) {
    const result = row.safeParse(raw);
    if (!result.success || result.data.id !== key) {
      diagnostic(`Model '${key}' has invalid Models.dev metadata`);
      continue;
    }
    const model = result.data;
    if (model.status === "deprecated" || model.tool_call === false) continue;
    const family = familyFor(
      model.provider?.npm ?? provider.npm,
      model.provider?.api ?? provider.api,
    );
    if (!family) {
      diagnostic(`Model '${key}' uses an unsupported Go transport`);
      continue;
    }
    const presets = presetsFor(model, family);
    const effortLevels = model.reasoning_options?.find(
      (option) => option.type === "effort",
    )?.values;
    models.push({
      model: key,
      ...(model.modalities?.input !== undefined
        ? { supportsImages: model.modalities.input.includes("image") }
        : {}),
      ...(model.name ? { label: model.name } : {}),
      family,
      contextWindow: model.limit.context,
      maxOutputTokens: model.limit.output,
      ...(model.limit.input !== undefined ? { maxInputTokens: model.limit.input } : {}),
      ...(model.reasoning !== undefined || effortLevels
        ? {
            reasoning: {
              ...(model.reasoning !== undefined ? { supported: model.reasoning } : {}),
              ...(effortLevels ? { effortLevels } : {}),
            },
          }
        : {}),
      ...(presets.length ? { presets } : {}),
      ...((key === "gpt-5.6-luna" || key === "gpt-6-luna") &&
      presets.some((preset) => preset.value === "medium")
        ? { defaultPreset: "medium" }
        : {}),
    });
  }
  if (!models.length)
    throw new ModelDiscoveryError(
      "invalid-response",
      "Models.dev Go catalog contains no supported models",
    );
  return { models, diagnostics };
}

function externalFailure(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  // Fetch's documented TypeError covers network/TLS failures. Other exceptions
  // indicate a programming defect and must not silently select the fallback.
  if (error instanceof TypeError)
    throw new ModelDiscoveryError("network", "Models.dev catalog request failed");
  throw error;
}

export async function fetchCatalog(signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(MODELS_DEV_URL, {
    signal,
    redirect: "error",
    headers: { "User-Agent": PRODUCT_USER_AGENT },
  }).catch((error: unknown) => externalFailure(error, signal));
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelDiscoveryError(
      "http",
      `Models.dev catalog returned HTTP ${response.status}`,
      response.status,
    );
  }
  if (!response.body)
    throw new ModelDiscoveryError("invalid-response", "Models.dev catalog has no body");
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      // The complete API is currently ~6 MiB; only the Go slice is retained.
      if (size > 16 * 1024 * 1024)
        throw new ModelDiscoveryError("limit", "Models.dev catalog exceeds 16 MiB");
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ModelDiscoveryError) throw error;
    externalFailure(error, signal);
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new ModelDiscoveryError("invalid-response", "Models.dev catalog is not valid JSON");
  }
}
