import type { CliPlugins } from "./client-plugins.ts";

/** Minimal client-plugin boundary for presentation tests. */
export const testPlugins = (overrides: Partial<CliPlugins> = {}): CliPlugins => ({
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
