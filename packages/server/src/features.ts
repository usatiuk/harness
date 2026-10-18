import { WorkspaceOperationError } from "@harness/protocol";
import { ResponseError } from "vscode-jsonrpc";
import { projectConversation } from "@harness/service";
import {
  worktreeRepositoryRequest,
  worktreeCreateConversationRequest,
  worktreeOptionsRequest,
  worktreeSwitchRequest,
  worktreeManagedRequest,
  worktreeRemoveRequest,
  changesListRequest,
  changesDiffRequest,
} from "@harness/worktrees/client";
import { listChanges, readChangeDiff } from "@harness/worktrees";
import type { ConversationId, JsonValue, RpcNotification } from "@harness/protocol";
import { conversationOf } from "@harness/protocol";

import type { HarnessRpcSession } from "@harness/service";
import {
  ActivityManager,
  activitiesEventNotification,
  activitiesSnapshotSchema,
  activityKillRequest,
  activityPeekRequest,
  isActivityEvent,
} from "@harness/activities";
import {
  DockerExecutionContext,
  isSandboxStatus,
  sandboxEventNotification,
  sandboxRebuildRequest,
  sandboxSnapshotSchema,
  sandboxStopRequest,
  type SandboxBackend,
} from "@harness/sandbox";
import type { ExecutionContext } from "@harness/execution";
import { registerSubagentServer } from "./subagents.ts";
import { subagentsTopLevelRequest } from "@harness/subagents";
import {
  createProcessActivity,
  workspaceShellEventNotification,
  workspaceShellRunRequest,
} from "@harness/workspace";

/** Register the concrete plugin messages at the server composition root. */
export function registerFeatureServer(session: HarnessRpcSession): void {
  const host = session.host;
  const service = host.service;
  registerSubagentServer(session);
  const worktreeOperation = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof WorkspaceOperationError) throw new ResponseError(-32000, error.message);
      throw error;
    }
  };
  const changesWorkspace = (id: ConversationId) => {
    const member = service
      .conversationTreeState(id)
      .find((member) => member.conversation.id === id);
    if (!member) throw new Error("Attached conversation has no runtime");
    return member.conversation.workspaceRoot;
  };
  session.onRequest(changesListRequest, (params, signal) =>
    session.runAttached(
      params.conversationId as ConversationId,
      (operationSignal) =>
        worktreeOperation(async () =>
          listChanges(
            changesWorkspace(params.conversationId as ConversationId),
            params,
            operationSignal,
          ),
        ),
      signal,
    ),
  );
  session.onRequest(changesDiffRequest, (params, signal) =>
    session.runAttached(
      params.conversationId as ConversationId,
      (operationSignal) =>
        worktreeOperation(async () =>
          readChangeDiff(
            changesWorkspace(params.conversationId as ConversationId),
            params,
            operationSignal,
          ),
        ),
      signal,
    ),
  );
  session.onRequest(worktreeRepositoryRequest, (params) =>
    worktreeOperation(() => service.worktreeRepository(params.path)),
  );
  session.onRequest(worktreeCreateConversationRequest, (params, signal) =>
    worktreeOperation(async () =>
      projectConversation(
        await service.createConversation({
          ...(params.cwd ? { cwd: params.cwd } : {}),
          overrides: params.overrides,
          newWorktree: true,
          signal,
        }),
      ),
    ),
  );
  session.onRequest(worktreeOptionsRequest, (params) =>
    worktreeOperation(() => service.workspaceOptions(params.conversationId as ConversationId)),
  );
  session.onRequest(worktreeSwitchRequest, async (params, signal) => {
    await session.assertWritable(params.conversationId as ConversationId);
    return worktreeOperation(() =>
      service.selectWorkspace(
        params.conversationId as ConversationId,
        params.selection,
        false,
        signal,
      ),
    );
  });
  session.onRequest(worktreeManagedRequest, (params) =>
    worktreeOperation(() => service.managedWorktrees(params.limit, params.before ?? undefined)),
  );
  session.onRequest(worktreeRemoveRequest, (params) =>
    worktreeOperation(async () => {
      await service.removeWorktree(params.path, params.force);
      return null;
    }),
  );

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
          { backend?: SandboxBackend } | undefined;
        const execution = service.existingService(conversation.id, "execution");
        return {
          conversationId: conversation.id,
          backend: backend?.backend ?? "none",
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
    return session.runWritable(id, async () => {
      const manager = service.existingService(id, "activities");
      return {
        status: manager instanceof ActivityManager ? manager.kill(activityId) : "unknown",
      };
    });
  });

  session.onRequest(workspaceShellRunRequest, async ({ conversationId, shellId, command }) => {
    const id = conversationId as ConversationId;
    return session.runWritable(id, async () => {
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
            host.broadcast(rootConversationId, activitiesEventNotification, {
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
        host.broadcast(rootConversationId, workspaceShellEventNotification, {
          rootConversationId,
          conversationId,
          shellId,
          event: { type: "data", text },
        }),
      );
      void proc.exit.then(({ code }) =>
        host.broadcast(rootConversationId, workspaceShellEventNotification, {
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
    return session.runWritable(
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
    return session.runWritable(
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
