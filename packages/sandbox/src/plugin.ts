import { z } from "zod";
import type { Conversation, PluginDefinition, ServiceProvider } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { DEFAULT_DEVCONTAINER_CONFIG } from "./devcontainer.ts";
import { DockerExecutionContext } from "./docker.ts";

/**
 * Config under `plugins.sandbox`. v1 enforces confinement via the container boundary. Network
 * restriction (`"none"`/allowlist) is deliberately NOT a schema option yet — it is unenforced, so
 * accepting it would silently fail open; the value returns when wired.
 */
export const sandboxConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Devcontainer config path, relative to the project root. */
  configPath: z.string().default(DEFAULT_DEVCONTAINER_CONFIG),
  /** Stop an idle container after this many minutes of no IO; `0` disables the idle timer. */
  idleTimeoutMinutes: z.number().int().min(0).default(10),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * The execution substrate, with optional dev-container sandboxing. Owns the host-wide `"execution"`
 * service key (unique), so it REPLACES the local execution plugin in the composition root. Per
 * conversation it returns a plain substrate chosen from the resolved config: docker when sandbox is
 * `enabled`, else local. There is no live switching — `/sandbox on|off` writes the setting, which
 * takes effect on the next conversation and (losslessly) on resume, because config is re-resolved on
 * every load. The devcontainer config is located and validated lazily inside the docker substrate
 * (resolving the `.devcontainer/` root first), so detection works from a subdirectory and a
 * misconfiguration fails loudly.
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
            const config = sandboxConfigSchema.parse(
              conversation.config.plugins?.["sandbox"] ?? {},
            );
            return config.enabled
              ? new DockerExecutionContext(conversation.workspaceRoot, config)
              : new LocalExecutionContext(conversation.workspaceRoot);
          },
        },
      ],
    };
  },
};
