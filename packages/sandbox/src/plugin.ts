import { z } from "zod";
import type { Conversation, PluginDefinition, ServiceProvider } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { DEFAULT_DEVCONTAINER_CONFIG } from "./devcontainer.ts";
import { DockerExecutionContext } from "./docker.ts";
import { NativeExecutionContext } from "./native.ts";

export const nativeSandboxConfigSchema = z.strictObject({
  workspaceWrite: z.boolean().default(true),
  network: z.boolean().default(true),
});
export type NativeSandboxConfig = z.infer<typeof nativeSandboxConfigSchema>;

export const dockerSandboxConfigSchema = z.strictObject({
  /** Devcontainer config path, relative to the project root. */
  configPath: z.string().default(DEFAULT_DEVCONTAINER_CONFIG),
  /** Stop an idle container after this many minutes of no IO; `0` disables the idle timer. */
  idleTimeoutMinutes: z.number().int().min(0).default(10),
});
export type DockerSandboxConfig = z.infer<typeof dockerSandboxConfigSchema>;

/** Config under `plugins.sandbox`; backend changes take effect on new/load. */
export const sandboxConfigSchema = z.strictObject({
  backend: z.enum(["local", "native", "docker"]).default("local"),
  native: nativeSandboxConfigSchema.default({ workspaceWrite: true, network: true }),
  docker: dockerSandboxConfigSchema.default({
    configPath: DEFAULT_DEVCONTAINER_CONFIG,
    idleTimeoutMinutes: 10,
  }),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;
export type SandboxBackend = SandboxConfig["backend"];

/**
 * Owns the host-wide `"execution"` service key and chooses Local, native Bubblewrap, or Docker from
 * the conversation's resolved configuration. The service remains fixed for a loaded conversation.
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
            switch (config.backend) {
              case "local":
                return new LocalExecutionContext(conversation.workspaceRoot);
              case "native":
                return new NativeExecutionContext(conversation.workspaceRoot, config.native);
              case "docker":
                return new DockerExecutionContext(conversation.workspaceRoot, config.docker);
            }
          },
        },
      ],
    };
  },
};
