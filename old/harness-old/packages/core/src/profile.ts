import type { EffectiveProfile, JsonValue, ProfileConfig } from "@harness/protocol";
import { profileConfigSchema } from "@harness/protocol";
import { nowIso } from "./ids.ts";
import type { HarnessStore } from "./store.ts";

export interface EffectiveProfileResolver {
  resolveProfile(input: {
    profileId?: string;
    projectConfig?: Partial<ProfileConfig>;
    dynamicConfigLayers?: Array<Partial<ProfileConfig>>;
    runOverrides?: Partial<ProfileConfig>;
  }): Promise<EffectiveProfile>;
}

export class CoreEffectiveProfileResolver implements EffectiveProfileResolver {
  public constructor(private readonly store: HarnessStore) {}

  public async resolveProfile(input: {
    profileId?: string;
    projectConfig?: Partial<ProfileConfig>;
    dynamicConfigLayers?: Array<Partial<ProfileConfig>>;
    runOverrides?: Partial<ProfileConfig>;
  }): Promise<EffectiveProfile> {
    const selectedProfileId = input.profileId ?? (await this.store.getDefaultProfileId());
    const profile = selectedProfileId ? await this.store.getProfile(selectedProfileId) : undefined;
    const layers: JsonValue[] = [
      profileConfigSchema.parse({}) as unknown as JsonValue,
      profile?.config as unknown as JsonValue | undefined,
      input.projectConfig as unknown as JsonValue | undefined,
      ...(input.dynamicConfigLayers ?? []).map((layer) => layer as unknown as JsonValue),
      input.runOverrides as unknown as JsonValue | undefined
    ].filter((layer): layer is JsonValue => layer !== undefined);
    const merged = layers.reduce((current, layer) => mergeJson(current, layer));
    const config = profileConfigSchema.parse(merged);
    const profileFields = profile
      ? {
          profileId: profile.id,
          profileName: profile.name,
          sourceProfileIds: [profile.id]
        }
      : {
          sourceProfileIds: []
        };
    return {
      ...profileFields,
      ...(input.runOverrides ? { runOverrides: input.runOverrides } : {}),
      config,
      resolvedAt: nowIso()
    };
  }
}

export function createProfileResolver(store: HarnessStore): CoreEffectiveProfileResolver {
  return new CoreEffectiveProfileResolver(store);
}

export function mergeProfileConfigLayers(layers: JsonValue[]): ProfileConfig {
  return profileConfigSchema.parse(layers.reduce((current, layer) => mergeJson(current, layer), profileConfigSchema.parse({}) as unknown as JsonValue));
}

function mergeJson(base: JsonValue, override: JsonValue): JsonValue {
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, JsonValue> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      const existing = result[key];
      result[key] = existing === undefined ? value : mergeJson(existing, value);
    }
    return result;
  }
  return override;
}

function isPlainObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
