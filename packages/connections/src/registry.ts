import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultHome } from "@harness/config";
import lockfile from "proper-lockfile";
import {
  clientConfigSchema,
  defaultClientConfig,
  hostSchema,
  type ClientConfig,
  type Host,
} from "./contracts.ts";
import { replaceJson } from "./local.ts";

/** This path belongs to the controlling client; remote HARNESS_HOME never changes it. */
export const clientConfigPath = (): string => join(defaultHome(), "client.json");

export async function readClientConfig(path = clientConfigPath()): Promise<ClientConfig> {
  try {
    return clientConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultClientConfig();
    throw error;
  }
}

export async function updateClientConfig(
  mutate: (config: ClientConfig) => ClientConfig,
  path = clientConfigPath(),
): Promise<ClientConfig> {
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 20, factor: 1, minTimeout: 50, maxTimeout: 50 },
  });
  try {
    const config = clientConfigSchema.parse(mutate(await readClientConfig(path)));
    await replaceJson(path, config);
    return config;
  } finally {
    await release();
  }
}

export function saveHost(value: Host, path?: string): Promise<ClientConfig> {
  const host = hostSchema.parse(value);
  return updateClientConfig(
    (config) => ({
      ...config,
      hosts: config.hosts.some((entry) => entry.id === host.id)
        ? config.hosts.map((entry) => (entry.id === host.id ? host : entry))
        : [...config.hosts, host],
    }),
    path,
  );
}
export function removeHost(id: string, path?: string): Promise<ClientConfig> {
  if (id === "local") throw new Error("Local cannot be removed");
  return updateClientConfig(
    (config) => ({
      ...config,
      hosts: config.hosts.filter((host) => host.id !== id),
      selectedHostId: config.selectedHostId === id ? "local" : config.selectedHostId,
    }),
    path,
  );
}
