import type { HarnessKernel } from "@harness/core";
import { createId, nowIso } from "@harness/core";
import type { JsonValue } from "@harness/protocol";
import { TASKS_NAMESPACE, type TaskItem, type TaskState } from "./types.ts";

export class TaskManager {
  public constructor(private readonly kernel: HarnessKernel) {}

  public async addTask(conversationId: string, title: string): Promise<TaskState> {
    const current = await this.readState(conversationId);
    const timestamp = nowIso();
    const next: TaskState = {
      tasks: [
        ...current.tasks,
        {
          id: createId("task"),
          title,
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ]
    };
    await this.kernel.updateStateNamespace({ conversationId, namespace: TASKS_NAMESPACE, value: next as unknown as JsonValue });
    return next;
  }

  private async readState(conversationId: string): Promise<TaskState> {
    const record = await this.kernel.store.getStateNamespace(conversationId, TASKS_NAMESPACE);
    if (!record) {
      return { tasks: [] };
    }
    const value = record.value as { tasks?: unknown };
    if (!Array.isArray(value.tasks)) {
      return { tasks: [] };
    }
    return { tasks: value.tasks as TaskItem[] };
  }
}
