import { z } from "zod";
import type { Conversation, PluginDefinition, ServiceProvider } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { DockerExecutionContext } from "./docker.ts";
import { DEFAULT_DEVCONTAINER_CONFIG } from "./devcontainer.ts";

/**
 * Config under `plugins.sandbox`. v1 enforces confinement via the container boundary. Network
 * restriction (`"none"`/allowlist) is deliberately NOT a schema option yet — it is unenforced, so
 * accepting it would silently fail open; the value returns when wired.
 */
export const sandboxConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Devcontainer config path, relative to the project root. */
  configPath: z.string().default(DEFAULT_DEVCONTAINER_CONFIG),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * The execution substrate, with optional dev-container sandboxing. Owns the host-wide `"execution"`
 * service key (unique), so it REPLACES the local execution plugin in the composition root. Per
 * conversation it picks the substrate: Docker when `enabled`, else the plain local context. The
 * devcontainer config is located and validated lazily in `DockerExecutionContext` (resolving the
 * project root first), so detection works from a subdirectory and a misconfiguration fails loudly.
 */
export const sandboxPlugin: PluginDefinition = {
  id: "sandbox",
  configSchema: sandboxConfigSchema,
  create() {
    return {
      id: "sandbox",
      services: (): ServiceProvider[] => [
        {
          key: "execution",
          for: (conversation: Conversation) => {
            const root = conversation.config.workspaceRoot ?? null;
            const config = sandboxConfigSchema.parse(
              conversation.config.plugins?.["sandbox"] ?? {},
            );
            return config.enabled
              ? new DockerExecutionContext(root, config)
              : new LocalExecutionContext(root);
          },
        },
      ],
    };
  },
};
