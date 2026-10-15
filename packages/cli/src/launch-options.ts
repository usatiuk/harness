export interface LaunchOptions {
  /** Resume mode (pick from a list when no `conversationId` is given). */
  resume?: boolean;
  worktree?: boolean | undefined;
  conversationId?: string | undefined;
  model?: string | undefined;
  cwd?: string | undefined;
  connectStdio?: boolean | undefined;
  ssh?: string | undefined;
  host?: string | undefined;
}
