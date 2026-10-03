import { z } from "zod";
import { ModelDiscoveryError } from "@harness/protocol";
import { modelIdSchema, modelProfileSchema, type ModelProfile } from "./config.ts";

const MAX_BYTES = 2 * 1024 * 1024;
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
      redirect: "error",
    });
  } catch {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
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
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof ModelDiscoveryError) throw error;
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
    const profile: ModelProfile = {};
    const maxOutputs = group.map((info) => info.max_output_tokens);
    if (
      maxOutputs.length &&
      maxOutputs.every((value) => typeof value === "number" && Number.isInteger(value) && value > 0)
    ) {
      if (maxOutputs.every((value) => value === maxOutputs[0]))
        profile.maxOutputTokens = maxOutputs[0] as number;
      else diagnostics.push(`Model '${id}' has conflicting output capacity metadata`);
    }
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
    return { id, profile, supported };
  });
  return { models, diagnostics };
}
