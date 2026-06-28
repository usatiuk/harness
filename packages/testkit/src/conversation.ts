import type {
  ConfigResolver,
  ConversationConfig,
  ModelConfig,
  NewConversationRecord,
} from "@harness/protocol";

/**
 * Builds a store-create input from a config-shaped object: the config fields become the durable
 * `overrides` layer (the top of the cascade, where `testConfigResolver` reads them back).
 * `workspaceRoot` defaults to projectless. Pairs with `testConfigResolver`.
 */
export function newConversationInput(
  config: Partial<ConversationConfig> & { workspaceRoot?: string | null } = {},
): NewConversationRecord {
  const { workspaceRoot = null, ...overrides } = config;
  return { workspaceRoot, overrides };
}

/**
 * A `ConfigResolver` for tests: it mirrors the real cascade minimally by reading the record's
 * `overrides` as the merged settings doc (model required, instructions/plugins defaulted). Because
 * `setModel` writes the new model into `overrides`, re-resolving through this returns the switched
 * model — so the engine's resolve-on-load and model-switch paths exercise the real shape.
 */
export function testConfigResolver(): ConfigResolver {
  return (record) => {
    const o = record.overrides as {
      instructions?: string;
      model?: ModelConfig;
      tools?: { allow?: string[] };
      plugins?: Record<string, unknown>;
    };
    // Mirror the real resolver, which throws rather than emit a config with no model — so a test that
    // forgets to set one fails loudly instead of silently carrying `undefined`.
    if (!o.model) return Promise.reject(new Error("no model configured"));
    return Promise.resolve({
      instructions: o.instructions ?? "",
      model: o.model,
      ...(o.tools ? { tools: o.tools } : {}),
      plugins: o.plugins ?? {},
    });
  };
}
