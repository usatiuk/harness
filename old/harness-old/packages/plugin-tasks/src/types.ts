export const TASKS_NAMESPACE = "plugin.tasks";

export interface TaskItem {
  id: string;
  title: string;
  status: "open" | "done";
  createdAt: string;
  updatedAt: string;
}

export interface TaskState {
  tasks: TaskItem[];
}
