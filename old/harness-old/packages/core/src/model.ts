import type { ModelCapabilities, ModelConfig, ModelStepInput, ModelStepResult, ProviderNativeToolConfig } from "@harness/protocol";

export interface ModelOutputObserver {
  onTextDelta?(delta: string): void | Promise<void>;
}

export interface ModelAdapter {
  id: string;
  provider: string;
  capabilities(): ModelCapabilities;
  supportedNativeToolKinds(): string[];
  validateModelConfig(config: ModelConfig): void;
  step(input: ModelStepInput, observer?: ModelOutputObserver): Promise<ModelStepResult>;
}

export class ModelRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  public constructor(adapters: ModelAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  public register(adapter: ModelAdapter): void {
    this.adapters.set(modelAdapterKey(adapter.provider, adapter.id), adapter);
  }

  public list(): ModelAdapter[] {
    return [...this.adapters.values()];
  }

  public get(provider: string, adapterId: string): ModelAdapter | undefined {
    return this.adapters.get(modelAdapterKey(provider, adapterId));
  }

  public resolve(config: ModelConfig): ModelAdapter {
    const adapter = this.get(config.provider, config.adapter);
    if (!adapter) {
      const available = this.list().map((item) => `${item.provider}/${item.id}`).sort();
      throw new Error(`No model adapter registered for ${config.provider}/${config.adapter}${available.length > 0 ? ` (available: ${available.join(", ")})` : ""}`);
    }
    validateNativeToolConfig(adapter, config);
    return adapter;
  }
}

export function createModelRegistry(adapters: ModelAdapter[] = []): ModelRegistry {
  return new ModelRegistry(adapters);
}

export function validateNativeToolConfig(adapter: ModelAdapter, config: ModelConfig): void {
  if (config.adapter !== adapter.id) {
    throw new Error(`Model config adapter ${config.adapter} does not match adapter ${adapter.id}`);
  }
  if (config.provider !== adapter.provider) {
    throw new Error(`Model config provider ${config.provider} does not match adapter provider ${adapter.provider}`);
  }
  const supported = new Set(adapter.supportedNativeToolKinds());
  const unsupported = config.nativeTools.filter((tool: ProviderNativeToolConfig) => tool.enabled && !supported.has(tool.kind));
  if (unsupported.length > 0) {
    throw new Error(`Adapter ${adapter.id} does not support native tool kind(s): ${unsupported.map((tool) => tool.kind).join(", ")}`);
  }
  adapter.validateModelConfig(config);
}

function modelAdapterKey(provider: string, adapterId: string): string {
  return `${provider}:${adapterId}`;
}
