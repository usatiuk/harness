import type { ZodType } from "zod";
import type { ModelProvider } from "./model.ts";

/** Opaque secret slots, scoped by the host to one stable provider instance ID. */
export interface ProviderSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface ProviderAuthStatus {
  authenticated: boolean;
  source?: "env" | "stored";
  detail?: string;
  expiresAt?: number;
}

interface ProviderAuthBase {
  readonly id: string;
  readonly label: string;
  status(): Promise<ProviderAuthStatus>;
  logout(): Promise<boolean>;
}

export interface ProviderApiKeyAuth extends ProviderAuthBase {
  readonly kind: "api-key";
  readonly envVar?: string;
  readonly canStore: boolean;
  validate(key: string): string | null;
  submit(key: string): Promise<void>;
  getKey(): Promise<string | null>;
}

export interface ProviderOAuth extends ProviderAuthBase {
  readonly kind: "oauth";
  login(opts: {
    flow: "browser" | "device";
    onUrl: (url: string, userCode?: string) => void;
    signal?: AbortSignal;
  }): Promise<void>;
}

export type ProviderAuth = ProviderApiKeyAuth | ProviderOAuth;

export interface ProviderInstanceContext {
  readonly id: string;
  readonly label: string;
  readonly secrets: ProviderSecrets;
}

/** One configured connection owns its authentication and constructed provider. */
export interface ProviderInstance {
  readonly auth?: ProviderAuth;
  buildProvider(): Promise<ModelProvider | null>;
}

/** Configuration is parsed synchronously before credential access or discovery. */
export interface ProviderType {
  readonly type: string;
  readonly configSchema: ZodType;
  prepare(config: unknown): (context: ProviderInstanceContext) => ProviderInstance;
}

export function defineProviderType<C>(definition: {
  type: string;
  configSchema: ZodType<C>;
  create(context: ProviderInstanceContext, config: C): ProviderInstance;
}): ProviderType {
  return {
    type: definition.type,
    configSchema: definition.configSchema,
    prepare: (raw) => {
      const config = definition.configSchema.parse(raw);
      return (context) => definition.create(context, config);
    },
  };
}

export interface ProviderTypeContributions {
  providerTypes?(): ProviderType[];
}

export interface ModelCatalogRefresh {
  status: "ready" | "degraded";
  diagnostics: string[];
}

export class ProviderCredentialError extends Error {
  constructor() {
    super("The configured credential backend is unavailable");
    this.name = "ProviderCredentialError";
  }
}

/** Expected sign-in failures with messages safe to display to the controlling client. */
export class ProviderSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSignInError";
  }
}

/** Classified external discovery failures. Messages contain no remote response bodies. */
export class ModelDiscoveryError extends Error {
  constructor(
    readonly code: "network" | "timeout" | "http" | "invalid-response" | "limit",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}
