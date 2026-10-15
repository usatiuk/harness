import type { CliPlugins } from "./client-plugins.ts";

/** Minimal client-plugin boundary for presentation tests. */
export const testPlugins = (overrides: Partial<CliPlugins> = {}): CliPlugins => ({
  worktreeRepository: async () => null,
  createWorktreeConversation: async () => {
    throw new Error("Not configured in this fixture");
  },
  dockerEnvironments: async () => [],
  controlDockerEnvironment: async () => {},
  workspaceOptions: async () => ({ original: "/work", current: "/work", worktrees: [] }),
  switchWorkspace: async () => {},
  managedWorktrees: async () => [],
  removeWorktree: async () => {},
  approvals: { subscribe: () => () => {}, respond: async () => {} },
  subscribe: () => () => {},
  runningActivities: () => 0,
  activities: () => ({ peek: () => [], kill: () => {} }),
  sandbox: (conversationId, backend) => ({
    conversationId,
    backend,
    containerActive: false,
  }),
  rebuildSandbox: async () => "not-docker",
  stopSandbox: async () => "not-docker",
  runShell: () => ({ id: "shell-test", accepted: Promise.resolve() }),
  topLevel: async (conversationIds) => new Set(conversationIds),
  ...overrides,
});
