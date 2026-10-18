import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, PluginDefinition, ServiceProvider } from "@harness/protocol";
import { executionServiceOf, LocalExecutionContext } from "@harness/execution";
import { sandboxConfigSchema } from "./config.ts";
import { DockerExecutionContext } from "./docker.ts";
import { dockerInventory, controlDockerWorkspace } from "./docker-inventory.ts";
import { DockerGuardian } from "./docker-guardian.ts";
import { DockerEnvironmentPool } from "./docker-environment.ts";
import { NativeExecutionContext } from "./native.ts";

/**
 * Owns the host-wide `"execution"` service key and chooses Local, native Bubblewrap, or Docker from
 * the conversation's resolved configuration. The service remains fixed within one activation.
 */
function definition(environments: DockerEnvironmentPool): PluginDefinition {
  return {
    id: "sandbox",
    configSchema: sandboxConfigSchema,
    inheritConfig: true,
    create() {
      return {
        id: "sandbox",
        contextSources: () => [
          {
            id: "sandbox",
            async instructions(ctx) {
              const execution = executionServiceOf(ctx);
              return execution instanceof NativeExecutionContext ||
                execution instanceof DockerExecutionContext
                ? [{ type: "text", text: await execution.sandboxInstructions() }]
                : [];
            },
          },
        ],
        services: (): ServiceProvider[] => [
          {
            key: "execution",
            scope: "workspace",
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
}

/** Server-owned physical environments; conversation services own only execution views. */
export function createSandboxRuntime(home: string, onFailure?: (error: Error) => void) {
  const guardian = new DockerGuardian(home, onFailure);
  const metadataRoot = join(home, "docker");
  const environments = new DockerEnvironmentPool(
    guardian.scope,
    async () => {
      await guardian.ensure();
      await mkdir(metadataRoot, { recursive: true });
    },
    metadataRoot,
  );
  return {
    plugin: definition(environments),
    environments,
    async close() {
      const errors: unknown[] = [];
      try {
        await environments.close();
      } catch (error) {
        errors.push(error);
      }
      if (guardian.started) {
        try {
          const results = await Promise.allSettled(
            (await dockerInventory(guardian.scope)).map((row) =>
              controlDockerWorkspace(guardian.scope, row.id, "stop"),
            ),
          );
          for (const result of results)
            if (result.status === "rejected") errors.push(result.reason);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await guardian.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Could not close Docker runtime");
    },
  };
}

export const sandboxPlugin: PluginDefinition = {
  id: "sandbox",
  configSchema: sandboxConfigSchema,
  inheritConfig: true,
  create(reader) {
    return definition(new DockerEnvironmentPool()).create(reader);
  },
};
