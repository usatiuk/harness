import { z } from "zod";
import { ModelDiscoveryError, modelReasoningInfoSchema } from "@harness/protocol";
import { modelIdSchema, modelProfileSchema, type ModelProfile } from "./config.ts";

const MAX_BYTES = 2 * 1024 * 1024;
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
export const MAX_MODELS = 5000;
const record = z.record(z.string(), z.unknown());
const indexSchema = z
  .object({ data: z.array(z.object({ id: modelIdSchema }).passthrough()).max(MAX_MODELS) })
  .passthrough();
const rowSchema = z
  .object({ model_name: modelIdSchema, model_info: record.nullish() })
  .passthrough();
const infoSchema = z
  .object({ data: z.union([z.array(rowSchema).max(MAX_MODELS), rowSchema]) })
  .passthrough();

/** Gateway-root joining preserves a reverse proxy prefix instead of resetting its path. */
export function gatewayUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function fetchCatalogJson(
  url: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
      redirect: "manual",
    });
  } catch (error) {
    if (abortedOperation(error, signal)) {
      signal.throwIfAborted();
    }
    if (!networkFailure(error)) throw error;
    throw new ModelDiscoveryError("network", "Catalog request could not reach the gateway");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelDiscoveryError(
      "http",
      `Catalog request returned HTTP ${response.status}`,
      response.status,
    );
  }
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) throw new ModelDiscoveryError("invalid-response", "Catalog response has no body");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES)
        throw new ModelDiscoveryError("limit", "Catalog response exceeds 2 MiB");
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (abortedOperation(error, signal)) signal.throwIfAborted();
    if (error instanceof ModelDiscoveryError) throw error;
    if (!networkFailure(error)) throw error;
    throw new ModelDiscoveryError("network", "Catalog response was interrupted");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new ModelDiscoveryError("invalid-response", "Catalog response is not valid JSON");
  }
}

export interface DiscoveredModel {
  id: string;
  profile: ModelProfile;
  supported: boolean;
}

export function parseIndex(raw: unknown): string[] {
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success)
    throw new ModelDiscoveryError("invalid-response", "Model index has an invalid data array");
  return [...new Set(parsed.data.data.map((row) => row.id))];
}

/** Only a complete, consistent deployment claim can describe the public routing alias. */
function agreedMetadata<T>(
  group: Record<string, unknown>[],
  field: string,
  schema: z.ZodType<T>,
  id: string,
  label: string,
  diagnostics: string[],
): T | undefined {
  const values = group.map((info) => info[field]);
  const known = values.filter((value) => value != null);
  if (!known.length) return undefined;
  const parsed = known.map((value) => schema.safeParse(value));
  if (parsed.some((value) => !value.success)) {
    diagnostics.push(`Model '${id}' has invalid ${label} metadata`);
    return undefined;
  }
  const valid = parsed.map((value) => {
    if (!value.success) throw new Error("Validated metadata invariant failed");
    return value.data;
  });
  if (!valid.every((value) => JSON.stringify(value) === JSON.stringify(valid[0]))) {
    diagnostics.push(`Model '${id}' has conflicting ${label} metadata`);
    return undefined;
  }
  return known.length === group.length ? valid[0] : undefined;
}

function legacyEfforts(info: Record<string, unknown>): string[] | undefined {
  const flags = Object.fromEntries(
    ["none", "minimal", "low", "xhigh", "max"].map((level) => [
      level,
      info[`supports_${level}_reasoning_effort`],
    ]),
  );
  const known = Object.values(flags).filter((value) => value != null);
  if (!known.length || known.some((value) => typeof value !== "boolean")) return undefined;
  // Legacy flags cannot exclude medium/high. Off needs explicit support; no provider guessing.
  return [
    ...(flags.none === true ? ["none"] : []),
    ...(flags.minimal !== false ? ["minimal"] : []),
    ...(flags.low !== false ? ["low"] : []),
    "medium",
    "high",
    ...(flags.xhigh === true ? ["xhigh"] : []),
    ...(flags.max === true ? ["max"] : []),
  ];
}

/** Only exact aliases from the public index may be enriched by deployment metadata. */
export function enrichModels(
  ids: string[],
  raw: unknown,
): { models: DiscoveredModel[]; diagnostics: string[] } {
  const parsed = infoSchema.safeParse(raw);
  if (!parsed.success)
    throw new ModelDiscoveryError("invalid-response", "Model metadata has an invalid data shape");
  const rows = Array.isArray(parsed.data.data) ? parsed.data.data : [parsed.data.data];
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const group = groups.get(row.model_name) ?? [];
    group.push(row.model_info ?? {});
    groups.set(row.model_name, group);
  }
  const diagnostics: string[] = [];
  const models = ids.map((id): DiscoveredModel => {
    const group = groups.get(id) ?? [];
    const supported = group.every(
      (info) =>
        (info.mode == null ||
          info.mode === "chat" ||
          info.mode === "completion" ||
          info.mode === "responses") &&
        (info.supports_function_calling == null || info.supports_function_calling === true) &&
        (info.supports_tool_calling == null || info.supports_tool_calling === true),
    );
    if (!supported) diagnostics.push(`Model '${id}' has unsupported mode or tool metadata`);
    const supportsImages = agreedMetadata(
      group,
      "supports_vision",
      z.boolean(),
      id,
      "image support",
      diagnostics,
    );
    const profile: ModelProfile = {};
    if (supportsImages !== undefined) profile.supportsImages = supportsImages;
    for (const [field, target, label] of [
      ["max_input_tokens", "maxInputTokens", "input capacity"],
      ["max_output_tokens", "maxOutputTokens", "output capacity"],
    ] as const) {
      const capacity = agreedMetadata(
        group,
        field,
        z.number().int().positive(),
        id,
        label,
        diagnostics,
      );
      if (capacity !== undefined) profile[target] = capacity;
    }
    // LiteLLM's legacy max_tokens field ambiguously means input OR output. It is not context.
    const reasoning: NonNullable<ModelProfile["reasoning"]> = {};
    for (const [field, target] of [
      ["supports_reasoning", "supported"],
      ["supports_adaptive_thinking", "adaptiveThinking"],
      ["supports_legacy_thinking", "legacyThinking"],
      ["thinking_always_on", "alwaysOn"],
    ] as const) {
      const value = agreedMetadata(group, field, z.boolean(), id, field, diagnostics);
      if (value !== undefined) reasoning[target] = value;
    }
    const claims = group.map((info) => ({
      ...info,
      reasoning_effort_levels:
        info.supports_reasoning === false
          ? []
          : (info.reasoning_effort_levels ?? legacyEfforts(info)),
    }));
    const levels = agreedMetadata(
      claims,
      "reasoning_effort_levels",
      modelReasoningInfoSchema.shape.effortLevels
        .unwrap()
        .transform((values) => [...new Set(values)].sort()),
      id,
      "reasoning effort levels",
      diagnostics,
    );
    if (levels !== undefined) reasoning.effortLevels = levels;
    const defaultEffort = agreedMetadata(
      group,
      "default_reasoning_effort",
      modelReasoningInfoSchema.shape.defaultEffort.unwrap(),
      id,
      "default reasoning effort",
      diagnostics,
    );
    if (defaultEffort !== undefined) {
      if (!levels || levels.includes(defaultEffort)) reasoning.defaultEffort = defaultEffort;
      else diagnostics.push(`Model '${id}' has an unadvertised default reasoning effort`);
    }
    if (Object.keys(reasoning).length) profile.reasoning = reasoning;
    const annotations = group.map((info) => info.harness).filter((value) => value !== undefined);
    if (annotations.length) {
      const schema = modelProfileSchema.extend({ version: z.literal(1) });
      const validated = annotations.map((annotation) => schema.safeParse(annotation));
      if (annotations.length !== group.length || validated.some((item) => !item.success)) {
        diagnostics.push(`Model '${id}' has incomplete or invalid Harness metadata`);
      } else {
        const profiles = validated.map((item) => {
          if (!item.success) throw new Error("Validated annotation invariant failed");
          return modelProfileSchema.parse(
            Object.fromEntries(Object.entries(item.data).filter(([key]) => key !== "version")),
          );
        });
        const first = profiles[0]!;
        for (const key of Object.keys(first) as (keyof ModelProfile)[]) {
          if (profiles.every((item) => JSON.stringify(item[key]) === JSON.stringify(first[key])))
            Object.assign(profile, { [key]: first[key] });
          else diagnostics.push(`Model '${id}' has conflicting Harness ${key} metadata`);
        }
      }
    }
    if (profile.defaultPreset && !Object.hasOwn(profile.presets ?? {}, profile.defaultPreset)) {
      delete profile.defaultPreset;
      diagnostics.push(`Model '${id}' has no agreed default preset`);
    }
    if (
      profile.reasoning?.defaultEffort &&
      profile.reasoning.effortLevels &&
      !profile.reasoning.effortLevels.includes(profile.reasoning.defaultEffort)
    ) {
      delete profile.reasoning.defaultEffort;
      diagnostics.push(`Model '${id}' has an unadvertised default reasoning effort`);
    }
    return { id, profile, supported };
  });
  return { models, diagnostics };
}
