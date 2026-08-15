import type { ConversationId, HarnessEvent, JsonValue, RpcNotification } from "@harness/protocol";
import { conversationOf } from "@harness/protocol";
import type { HarnessClient } from "@harness/client";
import type { HarnessRpcSession, HarnessService } from "@harness/service";
import {
  ACTIVITIES_CLIENT_CONTRACT_VERSION,
  ActivityManager,
  activitiesEventNotification,
  activitiesSnapshotSchema,
  activityKillRequest,
  activityPeekRequest,
  isActivityEvent,
  type ActivityState,
} from "@harness/activities";
import {
  DockerExecutionContext,
  SANDBOX_CLIENT_CONTRACT_VERSION,
  isSandboxStatus,
  sandboxEventNotification,
  sandboxRebuildRequest,
  sandboxSnapshotSchema,
  sandboxStopRequest,
  type SandboxBackend,
  type SandboxState,
} from "@harness/sandbox";
import type { ExecutionContext } from "@harness/execution";
import { SUBAGENTS_CLIENT_CONTRACT_VERSION, subagentsTopLevelRequest } from "@harness/subagents";
import {
  WORKSPACE_CLIENT_CONTRACT_VERSION,
  createProcessActivity,
  workspaceShellEventNotification,
  workspaceShellRunRequest,
} from "@harness/workspace";
import type { ApprovalClient } from "@harness/approval";
import type { ActivitiesView } from "./activities-overlay.tsx";

export const CLI_PLUGIN_CONTRACTS = [
  { id: "activities", version: ACTIVITIES_CLIENT_CONTRACT_VERSION },
  { id: "sandbox", version: SANDBOX_CLIENT_CONTRACT_VERSION },
  { id: "workspace", version: WORKSPACE_CLIENT_CONTRACT_VERSION },
  { id: "subagents", version: SUBAGENTS_CLIENT_CONTRACT_VERSION },
] as const;

export type ShellClientEvent =
  | { type: "data"; text: string }
  | { type: "exited"; exitCode: number };

export interface ShellRun {
  readonly id: string;
  readonly accepted: Promise<void>;
}

export interface CliPlugins {
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
  topLevel(conversationIds: ConversationId[]): Promise<Set<ConversationId>>;
}

/** Client-owned plugin state and operations used by the TUI. */
export class CliPluginClient implements CliPlugins {
  readonly approvals: ApprovalClient;
  readonly #client: HarnessClient;
  readonly #activities = new Map<string, Map<string, ActivityState>>();
  readonly #sandbox = new Map<string, SandboxState>();
  readonly #listeners = new Map<string, Set<(event: HarnessEvent) => void>>();
  readonly #shells = new Map<string, (shellId: string, event: ShellClientEvent) => void>();
  #shellSeq = 0;

  constructor(client: HarnessClient, approvals: ApprovalClient) {
    this.#client = client;
    this.approvals = approvals;
    client.subscribe((event) => {
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
    const shellId = `shell-${++this.#shellSeq}`;
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

/** Register the concrete plugin messages at the server composition root. */
export function registerCliPluginServer(session: HarnessRpcSession, service: HarnessService): void {
  const send = <P extends JsonValue>(definition: RpcNotification<P>, params: P): void => {
    void session.notify(definition, params).catch(() => {
      session.server.peer.terminateProtocol("failed to send a plugin event");
    });
  };

  session.registerSnapshot("activities", (rootId) =>
    activitiesSnapshotSchema.parse({
      activities: service.conversationTreeState(rootId).flatMap(({ conversation }) => {
        const manager = service.existingService(conversation.id, "activities");
        if (!(manager instanceof ActivityManager)) return [];
        return manager.list().map((activity) => {
          const result = manager.resultOf(activity.id);
          return {
            conversationId: conversation.id,
            id: activity.id,
            kind: activity.kind,
            title: activity.title,
            status: result?.status ?? null,
            summary: result?.summary ?? null,
          };
        });
      }),
    }),
  );
  session.registerSnapshot("sandbox", (rootId) =>
    sandboxSnapshotSchema.parse({
      members: service.conversationTreeState(rootId).map(({ conversation }) => {
        const backend = conversation.config.plugins?.["sandbox"] as
          | { backend?: SandboxBackend }
          | undefined;
        const execution = service.existingService(conversation.id, "execution");
        return {
          conversationId: conversation.id,
          backend: backend?.backend ?? "local",
          containerActive: execution instanceof DockerExecutionContext && execution.isProvisioned(),
        };
      }),
    }),
  );

  session.observeEvents((event, rootId) => {
    if (isActivityEvent(event)) {
      send(activitiesEventNotification, {
        rootConversationId: rootId,
        event:
          event.type === "activity.started"
            ? {
                type: "started",
                conversationId: event.conversationId,
                id: event.id,
                kind: event.kind,
                title: event.title,
              }
            : {
                type: "exited",
                conversationId: event.conversationId,
                id: event.id,
                status: event.status,
                summary: event.summary,
              },
      });
    } else if (isSandboxStatus(event)) {
      const conversationId = conversationOf(event);
      if (conversationId === undefined) return;
      send(sandboxEventNotification, {
        rootConversationId: rootId,
        conversationId,
        phase: event.phase,
        message: event.message ?? null,
      });
    }
  });

  session.onRequest(activityPeekRequest, async ({ conversationId, activityId }) => {
    const id = conversationId as ConversationId;
    return session.runAttached(id, async () => {
      const manager = service.existingService(id, "activities");
      return {
        content: manager instanceof ActivityManager ? (manager.get(activityId)?.peek() ?? []) : [],
      };
    });
  });
  session.onRequest(activityKillRequest, async ({ conversationId, activityId }) => {
    const id = conversationId as ConversationId;
    return session.runAttached(id, async () => {
      const manager = service.existingService(id, "activities");
      return {
        status: manager instanceof ActivityManager ? manager.kill(activityId) : "unknown",
      };
    });
  });

  session.onRequest(workspaceShellRunRequest, async ({ conversationId, shellId, command }) => {
    const id = conversationId as ConversationId;
    return session.runAttached(id, async () => {
      const execution = service.service(id, "execution") as ExecutionContext | undefined;
      const manager = service.service(id, "activities");
      if (execution === undefined || !(manager instanceof ActivityManager)) {
        throw new Error("workspace shell services are not configured");
      }
      if (manager.get(shellId) !== undefined) {
        throw new Error(`workspace shell '${shellId}' is already active`);
      }
      const rootConversationId = service.rootConversationOf(id);
      const proc = execution.spawn(command);
      const activity = createProcessActivity({
        id: shellId,
        title: command,
        proc,
        store: execution.outputStore(id),
      });
      manager.track(
        { ...activity, kind: "shell" },
        {
          callId: shellId,
          emit: (event) => {
            if (!isActivityEvent(event)) return;
            send(activitiesEventNotification, {
              rootConversationId,
              event:
                event.type === "activity.started"
                  ? {
                      type: "started",
                      conversationId: event.conversationId,
                      id: event.id,
                      kind: event.kind,
                      title: event.title,
                    }
                  : {
                      type: "exited",
                      conversationId: event.conversationId,
                      id: event.id,
                      status: event.status,
                      summary: event.summary,
                    },
            });
          },
        },
      );
      proc.onData((text) =>
        send(workspaceShellEventNotification, {
          rootConversationId,
          conversationId,
          shellId,
          event: { type: "data", text },
        }),
      );
      void proc.exit.then(({ code }) =>
        send(workspaceShellEventNotification, {
          rootConversationId,
          conversationId,
          shellId,
          event: { type: "exited", exitCode: code ?? 1 },
        }),
      );
      return null;
    });
  });

  const sandbox = (conversationId: string): DockerExecutionContext | undefined => {
    const id = conversationId as ConversationId;
    const execution = service.existingService(id, "execution");
    return execution instanceof DockerExecutionContext ? execution : undefined;
  };
  session.onRequest(sandboxRebuildRequest, async ({ conversationId }, signal) => {
    const id = conversationId as ConversationId;
    return session.runAttached(
      id,
      async (operationSignal) => {
        const execution = sandbox(conversationId);
        if (execution === undefined) return { status: "not-docker" as const };
        await execution.rebuild(operationSignal);
        return {
          status: "done" as const,
          state: { conversationId, backend: "docker" as const, containerActive: true },
        };
      },
      signal,
    );
  });
  session.onRequest(sandboxStopRequest, async ({ conversationId }, signal) => {
    const id = conversationId as ConversationId;
    return session.runAttached(
      id,
      async () => {
        const execution = sandbox(conversationId);
        if (execution === undefined) return { status: "not-docker" as const };
        await execution.stop();
        return {
          status: "done" as const,
          state: { conversationId, backend: "docker" as const, containerActive: false },
        };
      },
      signal,
    );
  });

  session.onRequest(subagentsTopLevelRequest, async ({ conversationIds }) => {
    const topLevel: string[] = [];
    for (const raw of conversationIds) {
      const id = raw as ConversationId;
      if ((await service.getPluginState("subagents", id, "spawn")) == null) topLevel.push(id);
    }
    return { conversationIds: topLevel };
  });
}
