import { z } from "zod";
import type { SecretStore } from "@harness/secrets";
import type { McpTransportConfig, McpValueSource } from "./config.ts";

export class McpAuthRequired extends Error {
  constructor() {
    super("Credentials or sign-in required");
  }
}
export class McpRegistrationRequired extends McpAuthRequired {
  constructor() {
    super();
    this.message =
      "Configure a client ID or compatible client metadata URL; this OAuth server does not support DCR";
  }
}
export class McpUnavailable extends Error {
  constructor(message = "MCP connection unavailable") {
    super(message);
  }
}
export class McpCredentialUnavailable extends McpUnavailable {
  constructor() {
    super();
    this.message = "MCP credential store unavailable";
  }
}
export function targetIdentity(config: McpTransportConfig): string {
  return config.type === "http"
    ? new URL(config.url).href
    : JSON.stringify({
        executable: config.executable,
        args: config.args,
        cwd: config.cwd ?? null,
      });
}
const credentialRecord = z.strictObject({ target: z.string(), value: z.string() });
export function scopedSecrets(
  store: SecretStore,
  id: string,
  namespace: "credential" | "oauth",
): SecretStore {
  const key = (slot: string) =>
    `mcp-server:${encodeURIComponent(id)}:${namespace}:${encodeURIComponent(slot)}`;
  const access = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch {
      throw new McpCredentialUnavailable();
    }
  };
  return {
    get: (slot) => access(() => store.get(key(slot))),
    set: (slot, value) => access(() => store.set(key(slot), value)),
    delete: (slot) => access(() => store.delete(key(slot))),
  };
}
export function decodeCredential<T>(raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new McpAuthRequired();
  }
}

export async function resolveValue(
  source: McpValueSource,
  target: string,
  store: SecretStore,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (source.type === "literal") return source.value;
  if (source.type === "env") {
    const value = env[source.name];
    if (value === undefined || value === "") throw new McpAuthRequired();
    return value;
  }
  const raw = await store.get(source.slot);
  if (raw === null) throw new McpAuthRequired();
  const record = decodeCredential(raw, credentialRecord);
  if (record.target !== target) throw new McpAuthRequired();
  return record.value;
}
export async function storeCredential(
  store: SecretStore,
  target: string,
  slot: string,
  value: string,
): Promise<void> {
  await store.set(slot, JSON.stringify({ target, value }));
}
/** All redirects are rejected; no credential can be forwarded to a different target. */
export async function authFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  } catch {
    throw new McpUnavailable();
  }
}
