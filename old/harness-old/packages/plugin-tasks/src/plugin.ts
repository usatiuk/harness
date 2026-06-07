import type { HarnessPlugin } from "@harness/core";
import { TASKS_NAMESPACE } from "./types.ts";

export function createTasksPlugin(): HarnessPlugin {
  return {
    id: TASKS_NAMESPACE
  };
}
