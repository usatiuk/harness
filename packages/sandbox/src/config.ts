import { z } from "zod";

/** Default config path relative to the project root. */
export const DEFAULT_DEVCONTAINER_CONFIG = ".devcontainer/devcontainer.json";

export const nativeSandboxConfigSchema = z.strictObject({
  workspaceWrite: z.boolean().default(true),
  network: z.boolean().default(true),
});
export type NativeSandboxConfig = z.infer<typeof nativeSandboxConfigSchema>;

export const dockerSandboxConfigSchema = z
  .strictObject({
    /** Devcontainer config path, relative to the project root. */
    configPath: z.string().default(DEFAULT_DEVCONTAINER_CONFIG),
    /** Accepted for existing settings files; workspace environments no longer idle-stop. */
    idleTimeoutMinutes: z.number().int().min(0).optional(),
  })
  .transform(({ configPath }) => ({ configPath }));
export type DockerSandboxConfig = z.infer<typeof dockerSandboxConfigSchema>;

/** Config under `plugins.sandbox`; backend changes take effect on activation/reload. */
export const sandboxConfigSchema = z.strictObject({
  backend: z.enum(["local", "native", "docker"]).default("local"),
  native: nativeSandboxConfigSchema.default({ workspaceWrite: true, network: true }),
  docker: dockerSandboxConfigSchema.default({
    configPath: DEFAULT_DEVCONTAINER_CONFIG,
  }),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;
export type SandboxBackend = SandboxConfig["backend"];
