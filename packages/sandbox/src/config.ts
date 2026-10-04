import { z } from "zod";

/** Default config path relative to the project root. */
export const DEFAULT_DEVCONTAINER_CONFIG = ".devcontainer/devcontainer.json";

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

/** Config under `plugins.sandbox`; backend changes take effect on activation/reload. */
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
