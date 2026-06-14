import type { ModelInfo, ModelProvider, Tool, ToolSchema } from "@harness/protocol";
import { toToolSchema } from "./tools.ts";

export class ProviderRegistry {
  readonly #byName = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    if (this.#byName.has(provider.provider)) {
      throw new Error(`duplicate provider: ${provider.provider}`);
    }
    this.#byName.set(provider.provider, provider);
  }

  /** Every registered provider's catalog, in registration order. */
  listModels(): ModelInfo[] {
    return [...this.#byName.values()].flatMap((p) => p.listModels());
  }

  get(name: string): ModelProvider {
    const provider = this.#byName.get(name);
    if (!provider) {
      throw new Error(`unknown provider: ${name}`);
    }
    return provider;
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }
}

/** The tools offered to the model on a single turn; duplicate names throw. */
export class ToolSet {
  readonly #byName = new Map<string, Tool>();

  constructor(tools: readonly Tool[]) {
    for (const tool of tools) {
      if (this.#byName.has(tool.name)) {
        throw new Error(`duplicate tool: ${tool.name}`);
      }
      this.#byName.set(tool.name, tool);
    }
  }

  get(name: string): Tool {
    const tool = this.#byName.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  /** A tool's opaque `meta` bag by name, or `undefined` if unknown / none. */
  metaOf(name: string): Record<string, unknown> | undefined {
    return this.#byName.get(name)?.meta;
  }

  /** Wire schemas for the offered tools, name-sorted for a cache-stable prefix. */
  schemas(): ToolSchema[] {
    return [...this.#byName.values()]
      .map(toToolSchema)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
