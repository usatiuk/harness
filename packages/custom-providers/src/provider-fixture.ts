import { MemorySecretStore } from "@harness/secrets";
import type { SettingsDoc } from "@harness/config";
import { customProviderTypes } from "./factory.ts";

/** Tests use the same type validation and instance construction as shipped bootstrap. */
export async function configuredProvider(id: string, type: string, config: unknown) {
  const definition = customProviderTypes.find((candidate) => candidate.type === type);
  if (!definition) throw new Error(`Unknown provider type '${type}'`);
  const instance = definition.prepare(config)({ id, label: id, secrets: new MemorySecretStore() });
  const provider = await instance.buildProvider();
  if (!provider) throw new Error(`Fixture provider '${id}' needs credentials`);
  return provider;
}

export async function configuredProviders(settings: SettingsDoc) {
  return Promise.all(
    Object.entries(settings.providers ?? {}).map(([id, entry]) =>
      configuredProvider(id, entry.type, entry.config),
    ),
  );
}
