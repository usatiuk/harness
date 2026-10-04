import type { Conversation, PluginDefinition, ServiceProvider } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { sandboxConfigSchema } from "./config.ts";
import { DockerExecutionContext } from "./docker.ts";
import { DockerEnvironmentPool } from "./docker-environment.ts";
import { NativeExecutionContext } from "./native.ts";

/**
 * Owns the host-wide `"execution"` service key and chooses Local, native Bubblewrap, or Docker from
 * the conversation's resolved configuration. The service remains fixed within one activation.
 */
export const sandboxPlugin: PluginDefinition = {
  id: "sandbox",
  configSchema: sandboxConfigSchema,
  inheritConfig: true,
  create() {
    const environments = new DockerEnvironmentPool();
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
                return new DockerExecutionContext(
                  conversation.workspaceRoot,
                  config.docker,
                  environments,
                );
            }
          },
          dispose: (service) =>
            service instanceof DockerExecutionContext ? service.dispose() : undefined,
        },
      ],
    };
  },
};
