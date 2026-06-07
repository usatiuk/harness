import type { ModelAdapter } from "@harness/core";
import type { ModelCapabilities, ModelConfig, ModelStepInput, ModelStepResult } from "@harness/protocol";

export const SOURCE_FIRST_MARKER = "model-ai-sdk:src";

export interface AiSdkModelAdapterOptions {
  id: string;
  provider: string;
  modelId: string;
  capabilities: ModelCapabilities;
  nativeToolKinds?: string[];
  validate?: (config: ModelConfig) => void;
  step: (input: ModelStepInput) => Promise<ModelStepResult>;
}

export class AiSdkModelAdapter implements ModelAdapter {
  public readonly id: string;
  public readonly provider: string;

  public constructor(private readonly options: AiSdkModelAdapterOptions) {
    this.id = options.id;
    this.provider = options.provider;
  }

  public capabilities(): ModelCapabilities {
    return this.options.capabilities;
  }

  public supportedNativeToolKinds(): string[] {
    return this.options.nativeToolKinds ?? [];
  }

  public validateModelConfig(config: ModelConfig): void {
    this.options.validate?.(config);
  }

  public async step(input: ModelStepInput): Promise<ModelStepResult> {
    return this.options.step(input);
  }
}

export function createAiSdkAdapterSkeleton(options: AiSdkModelAdapterOptions): AiSdkModelAdapter {
  return new AiSdkModelAdapter(options);
}
