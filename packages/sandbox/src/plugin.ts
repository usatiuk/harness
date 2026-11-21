import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, PluginDefinition, ServiceProvider } from "@harness/protocol";
import { executionServiceOf, LocalExecutionContext } from "@harness/execution";
import { sandboxConfigSchema, type SandboxBackend } from "./config.ts";
import { DockerExecutionContext } from "./docker.ts";
import { dockerInventory, controlDockerWorkspace } from "./docker-inventory.ts";
import { DockerGuardian } from "./docker-guardian.ts";
import { DockerEnvironmentPool } from "./docker-environment.ts";
import {
  detectNativeSandboxHost,
  NativeExecutionContext,
  nativeSandboxAvailable,
  type NativeSandboxHost,
} from "./native.ts";

/**
 * Owns the host-wide `"execution"` service key and chooses Local, native MXC, or Docker from
 * the conversation's resolved configuration. The service remains fixed within one activation.
 */
function definition(
  environments: DockerEnvironmentPool,
  nativeHost?: NativeSandboxHost,
): PluginDefinition {
  return {
    id: "sandbox",
    configSchema: sandboxConfigSchema,
    inheritConfig: true,
    create() {
      let host = nativeHost;
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
                case "none":
                  return new LocalExecutionContext(conversation.workspaceRoot);
                case "native": {
                  const support = (host ??= detectNativeSandboxHost());
                  if (!support.available)
                    throw new Error("MXC native sandbox unavailable: " + support.reason);
                  return new NativeExecutionContext(conversation.workspaceRoot, config.native);
                }
                case "docker":
                  return new DockerExecutionContext(
                    conversation.workspaceRoot,
                    config.docker,
                    environments,
                  );
              }
            },
            dispose: (service) =>
              service instanceof NativeExecutionContext || service instanceof DockerExecutionContext
                ? service.dispose()
                : undefined,
          },
        ],
      };
    },
  };
}

/** Server-owned physical environments; conversation services own only execution views. */
export async function createSandboxRuntime(home: string, onFailure?: (error: Error) => void) {
  const nativeHost = detectNativeSandboxHost();
  const defaultBackend: SandboxBackend = (await nativeSandboxAvailable(nativeHost))
    ? "native"
    : "none";
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
    plugin: definition(environments, nativeHost),
    defaultBackend,
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
