import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Conversation, PluginDefinition, ServiceProvider } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { DockerExecutionContext } from "./docker.ts";

/**
 * Config under `plugins.sandbox`. The reserved access knobs (`mounts`, `mountSecrets`) are declared
 * now so the security tier is a config flip, not a redesign; v1 enforces confinement via the
 * container boundary. Network restriction (`"none"`/allowlist) is deliberately NOT a schema option
 * yet — it is unenforced, so accepting it would silently fail open; the value returns when wired.
 */
export const sandboxConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Devcontainer config path, relative to the workspace root. Absent file ⇒ sandbox stays off. */
  configPath: z.string().default(".devcontainer/devcontainer.json"),
  /** Extra host paths the agent may reach; empty = project root only. (Reserved; not yet wired.) */
  mounts: z.array(z.string()).default([]),
  /** Bind host secrets (~/.ssh, ~/.aws) into the container. (Reserved; not yet wired.) */
  mountSecrets: z.boolean().default(false),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

function hasDevcontainer(root: string | null, configPath: string): boolean {
  return root !== null && existsSync(join(root, configPath));
}

/**
 * The execution substrate, with optional dev-container sandboxing. Owns the host-wide `"execution"`
 * service key (unique), so it REPLACES the local execution plugin in the composition root. Per
 * conversation it picks the substrate: Docker when `enabled` and a devcontainer config exists, else
 * the plain local context.
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
            return config.enabled && hasDevcontainer(root, config.configPath)
              ? new DockerExecutionContext(root, config)
              : new LocalExecutionContext(root);
          },
        },
      ],
    };
  },
};
