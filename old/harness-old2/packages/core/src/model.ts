import type { ModelCapabilities, ModelConfig, ModelStepInput, ModelStepResult } from "@harness/protocol";

export interface ModelOutputObserver {
  onTextDelta?(delta: string): void | Promise<void>;
}

export interface ModelAdapter {
  id: string;
  provider: string;
  capabilities(): ModelCapabilities;
  validateModelConfig(config: ModelConfig): void;
  step(input: ModelStepInput, observer?: ModelOutputObserver): Promise<ModelStepResult>;
}

export class ModelRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  public register(adapter: ModelAdapter): void {
    this.adapters.set(`${adapter.provider}/${adapter.id}`, adapter);
  }

  public resolve(config: ModelConfig): ModelAdapter {
    const adapter = this.adapters.get(`${config.provider}/${config.adapter}`);
    if (!adapter) {
      const available = [...this.adapters.keys()].sort();
      throw new Error(`No model adapter registered for ${config.provider}/${config.adapter}${available.length ? ` (available: ${available.join(", ")})` : ""}`);
    }
    adapter.validateModelConfig(config);
    return adapter;
  }
}

export class EchoModelAdapter implements ModelAdapter {
  public readonly id = "fake";
  public readonly provider = "fake";

  public capabilities(): ModelCapabilities {
    return { textInput: true, textOutput: true, reasoningMetadata: false };
  }

  public validateModelConfig(config: ModelConfig): void {
    if (config.provider !== this.provider || config.adapter !== this.id) {
      throw new Error(`Echo adapter cannot run ${config.provider}/${config.adapter}`);
    }
  }

  public async step(input: ModelStepInput): Promise<ModelStepResult> {
    const text = input.messages.flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return {
      content: [{ type: "text", text: text.length > 0 ? `echo: ${text}` : "echo" }],
      metadata: { adapter: "fake" }
    };
  }
}
