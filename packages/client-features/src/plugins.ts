import {
  worktreeRepositoryRequest,
  worktreeCreateConversationRequest,
  WORKTREES_CLIENT_CONTRACT_VERSION,
  worktreeOptionsRequest,
  worktreeSwitchRequest,
  worktreeManagedRequest,
  worktreeRemoveRequest,
} from "@harness/worktrees/client";
import type { ManagedWorktree, WorkspaceSelection, WorktreeInfo } from "@harness/protocol";
import type { ConversationId, HarnessEvent, ContentBlock } from "@harness/protocol";
import type { HarnessClient } from "@harness/client";
import {
  ACTIVITIES_CLIENT_CONTRACT_VERSION,
  activitiesEventNotification,
  activitiesSnapshotSchema,
  activityKillRequest,
  activityPeekRequest,
  type ActivityState,
} from "@harness/activities/client";
import {
  sandboxEnvironmentsRequest,
  sandboxEnvironmentControlRequest,
  SANDBOX_CLIENT_CONTRACT_VERSION,
  sandboxEventNotification,
  sandboxRebuildRequest,
  sandboxSnapshotSchema,
  sandboxStopRequest,
  type SandboxBackend,
  type SandboxState,
} from "@harness/sandbox/client";
import {
  SUBAGENTS_CLIENT_CONTRACT_VERSION,
  subagentsTopLevelRequest,
  subagentsInspectRequest,
  subagentsListRequest,
  type SubagentIdentity,
  type SubagentPage,
} from "@harness/subagents/client";
import {
  WORKSPACE_CLIENT_CONTRACT_VERSION,
  workspaceShellEventNotification,
  workspaceShellRunRequest,
} from "@harness/workspace/client";
import type { ApprovalClient } from "@harness/approval/client";
export type { SubagentIdentity, SubagentRow, SubagentPage } from "@harness/subagents/client";

export interface ActivitiesView {
  peek(id: string): ContentBlock[] | Promise<ContentBlock[]>;
  kill(id: string): void | Promise<void>;
}
export const FEATURE_PLUGIN_CONTRACTS = [
  { id: "worktrees", version: WORKTREES_CLIENT_CONTRACT_VERSION },
  { id: "activities", version: ACTIVITIES_CLIENT_CONTRACT_VERSION },
  { id: "sandbox", version: SANDBOX_CLIENT_CONTRACT_VERSION },
  { id: "workspace", version: WORKSPACE_CLIENT_CONTRACT_VERSION },
  { id: "subagents", version: SUBAGENTS_CLIENT_CONTRACT_VERSION },
] as const;

export type ShellClientEvent =
  { type: "data"; text: string } | { type: "exited"; exitCode: number };

export interface ShellRun {
  readonly id: string;
  readonly accepted: Promise<void>;
}

export interface HarnessPlugins {
  worktreeRepository(path: string): Promise<string | null>;
  createWorktreeConversation(
    cwd: string,
    overrides: Record<string, unknown>,
  ): Promise<import("@harness/protocol").WireConversation>;
  dockerEnvironments(
    limit: number,
    before?: string,
  ): Promise<
    Array<{ id: string; workspaceRoot: string | null; running: boolean; containers: number }>
  >;
  controlDockerEnvironment(id: string, action: "stop" | "remove"): Promise<void>;
  workspaceOptions(
    id: ConversationId,
  ): Promise<{ original: string; current: string; worktrees: WorktreeInfo[] } | null>;
  switchWorkspace(id: ConversationId, selection: WorkspaceSelection): Promise<void>;
  managedWorktrees(limit: number, before?: string): Promise<ManagedWorktree[]>;
  removeWorktree(path: string, force: boolean): Promise<void>;

  readonly approvals: Pick<ApprovalClient, "subscribe" | "respond">;
  subscribe(rootId: ConversationId, listener: (event: HarnessEvent) => void): () => void;
  runningActivities(rootId: ConversationId): number;
  activities(rootId: ConversationId): ActivitiesView;
  sandbox(conversationId: ConversationId, fallback: SandboxBackend): SandboxState;
  rebuildSandbox(conversationId: ConversationId): Promise<"done" | "not-docker">;
  stopSandbox(conversationId: ConversationId): Promise<"done" | "not-docker">;
  runShell(
    conversationId: ConversationId,
    command: string,
    listener: (shellId: string, event: ShellClientEvent) => void,
  ): ShellRun;
  inspectSubagent(id: ConversationId): Promise<SubagentIdentity | null>;
  listSubagents(
    id: ConversationId,
    cursor?: SubagentPage["nextCursor"],
    signal?: AbortSignal,
  ): Promise<SubagentPage>;
  topLevel(conversationIds: ConversationId[]): Promise<Set<ConversationId>>;
}

/** Client-owned plugin state and operations shared by presentation clients. */
export class HarnessPluginClient implements HarnessPlugins {
  readonly approvals: ApprovalClient;
  readonly #client: HarnessClient;
  readonly #activities = new Map<string, Map<string, ActivityState>>();
  readonly #sandbox = new Map<string, SandboxState>();
  readonly #listeners = new Map<string, Set<(event: HarnessEvent) => void>>();
  readonly #shells = new Map<string, (shellId: string, event: ShellClientEvent) => void>();

  dockerEnvironments(limit: number, before?: string) {
    return this.#client.peer.request(sandboxEnvironmentsRequest, { limit, before: before ?? null });
  }
  async controlDockerEnvironment(id: string, action: "stop" | "remove"): Promise<void> {
    await this.#client.peer.request(sandboxEnvironmentControlRequest, { id, action });
  }
  worktreeRepository(path: string) {
    return this.#client.peer.request(worktreeRepositoryRequest, { path });
  }
  createWorktreeConversation(cwd: string, overrides: Record<string, unknown>) {
    return this.#client.peer.request(
      worktreeCreateConversationRequest,
      worktreeCreateConversationRequest.params.parse({ cwd, overrides }),
    );
  }
  workspaceOptions(id: ConversationId) {
    return this.#client.peer.request(worktreeOptionsRequest, { conversationId: id });
  }
  async switchWorkspace(id: ConversationId, selection: WorkspaceSelection): Promise<void> {
    await this.#client.peer.request(worktreeSwitchRequest, { conversationId: id, selection });
  }
  managedWorktrees(limit: number, before?: string) {
    return this.#client.peer.request(worktreeManagedRequest, { limit, before: before ?? null });
  }
  async removeWorktree(path: string, force: boolean): Promise<void> {
    await this.#client.peer.request(worktreeRemoveRequest, { path, force });
  }

  constructor(client: HarnessClient, approvals: ApprovalClient) {
    this.#client = client;
    this.approvals = approvals;
    client.subscribe((event) => {
      if (event.type === "detached") {
        this.#activities.delete(event.rootConversationId);
        for (const id of event.conversationIds) this.#sandbox.delete(id);
        return;
      }
      if (event.type !== "attached") return;
      const root = event.attachment.root.id;
      const activities = activitiesSnapshotSchema.parse(
        event.attachment.plugins["activities"] ?? { activities: [] },
      );
      this.#activities.set(
        root,
        new Map(activities.activities.map((activity) => [activity.id, activity])),
      );
      const sandbox = sandboxSnapshotSchema.parse(
        event.attachment.plugins["sandbox"] ?? { members: [] },
      );
      for (const state of sandbox.members) this.#sandbox.set(state.conversationId, state);
    });
    client.peer.onNotification(activitiesEventNotification, (params) => {
      const { rootConversationId, event } = params;
      client.receive(rootConversationId, params, () => {
        let activities = this.#activities.get(rootConversationId);
        if (activities === undefined) {
          activities = new Map();
          this.#activities.set(rootConversationId, activities);
        }
        if (event.type === "started") {
          activities.set(event.id, {
            conversationId: event.conversationId,
            id: event.id,
            kind: event.kind,
            title: event.title,
            status: null,
            summary: null,
          });
          this.#emit(rootConversationId, {
            type: "activity.started",
            conversationId: event.conversationId,
            id: event.id,
            kind: event.kind,
            title: event.title,
          });
        } else {
          const current = activities.get(event.id);
          if (current !== undefined) {
            activities.set(event.id, {
              ...current,
              status: event.status,
              summary: event.summary,
            });
          }
          this.#emit(rootConversationId, {
            type: "activity.exited",
            conversationId: event.conversationId,
            id: event.id,
            status: event.status,
            summary: event.summary,
          });
        }
      });
    });
    client.peer.onNotification(sandboxEventNotification, (event) => {
      client.receive(event.rootConversationId, event, () => {
        this.#emit(event.rootConversationId, {
          type: "sandbox.status",
          conversationId: event.conversationId,
          phase: event.phase,
          ...(event.message === null ? {} : { message: event.message }),
        });
      });
    });
    client.peer.onNotification(workspaceShellEventNotification, (params) => {
      client.receive(params.rootConversationId, params, () => {
        const key = this.#shellKey(params.conversationId, params.shellId);
        this.#shells.get(key)?.(params.shellId, params.event);
        if (params.event.type === "exited") this.#shells.delete(key);
      });
    });
  }

  subscribe(rootId: ConversationId, listener: (event: HarnessEvent) => void): () => void {
    let listeners = this.#listeners.get(rootId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(rootId, listeners);
    }
    listeners.add(listener);
    for (const activity of this.#activities.get(rootId)?.values() ?? []) {
      listener({
        type: "activity.started",
        conversationId: activity.conversationId,
        id: activity.id,
        kind: activity.kind,
        title: activity.title,
      });
      if (activity.status !== null && activity.summary !== null) {
        listener({
          type: "activity.exited",
          conversationId: activity.conversationId,
          id: activity.id,
          status: activity.status,
          summary: activity.summary,
        });
      }
    }
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(rootId);
    };
  }

  runningActivities(rootId: ConversationId): number {
    let count = 0;
    for (const activity of this.#activities.get(rootId)?.values() ?? []) {
      if (activity.status === null) count++;
    }
    return count;
  }

  activities(rootId: ConversationId): ActivitiesView {
    return {
      peek: async (id) => {
        const activity = this.#activities.get(rootId)?.get(id);
        if (activity === undefined) return [];
        return (
          await this.#client.peer.request(activityPeekRequest, {
            conversationId: activity.conversationId,
            activityId: id,
          })
        ).content;
      },
      kill: async (id) => {
        const activity = this.#activities.get(rootId)?.get(id);
        if (activity === undefined) return;
        await this.#client.peer.request(activityKillRequest, {
          conversationId: activity.conversationId,
          activityId: id,
        });
      },
    };
  }

  sandbox(conversationId: ConversationId, fallback: SandboxBackend): SandboxState {
    return (
      this.#sandbox.get(conversationId) ?? {
        conversationId,
        backend: fallback,
        containerActive: false,
      }
    );
  }

  async rebuildSandbox(conversationId: ConversationId): Promise<"done" | "not-docker"> {
    const result = await this.#client.peer.request(sandboxRebuildRequest, { conversationId });
    if (result.status === "done") this.#sandbox.set(conversationId, result.state);
    return result.status;
  }

  async stopSandbox(conversationId: ConversationId): Promise<"done" | "not-docker"> {
    const result = await this.#client.peer.request(sandboxStopRequest, { conversationId });
    if (result.status === "done") this.#sandbox.set(conversationId, result.state);
    return result.status;
  }

  runShell(
    conversationId: ConversationId,
    command: string,
    listener: (shellId: string, event: ShellClientEvent) => void,
  ): ShellRun {
    const shellId = `shell-${globalThis.crypto.randomUUID()}`;
    const key = this.#shellKey(conversationId, shellId);
    this.#shells.set(key, listener);
    const accepted = this.#client.peer
      .request(workspaceShellRunRequest, {
        conversationId,
        shellId,
        command,
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#shells.delete(key);
        throw error;
      });
    return { id: shellId, accepted };
  }

  inspectSubagent(id: ConversationId) {
    return this.#client.peer.request(subagentsInspectRequest, { conversationId: id });
  }
  listSubagents(
    id: ConversationId,
    cursor: SubagentPage["nextCursor"] = null,
    signal?: AbortSignal,
  ) {
    return this.#client.peer.request(
      subagentsListRequest,
      { conversationId: id, limit: 20, cursor },
      signal ? { signal } : undefined,
    );
  }

  async topLevel(conversationIds: ConversationId[]): Promise<Set<ConversationId>> {
    const result = await this.#client.peer.request(subagentsTopLevelRequest, {
      conversationIds,
    });
    return new Set(result.conversationIds as ConversationId[]);
  }

  #shellKey(conversationId: string, shellId: string): string {
    return `${conversationId}\u0000${shellId}`;
  }

  #emit(rootId: string, event: HarnessEvent): void {
    for (const listener of this.#listeners.get(rootId) ?? []) listener(event);
  }
}
