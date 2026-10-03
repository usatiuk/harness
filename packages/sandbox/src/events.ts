export type SandboxPhase = "build" | "create" | "postCreate" | "ready" | "error" | "warning";

/**
 * Build/start progress, emitted onto the conversation stream so a client can render a bar. The
 * open index signature makes it a structural `PluginEvent` (the kernel stamps `conversationId`).
 */
export interface SandboxStatus {
  type: "sandbox.status";
  phase: SandboxPhase;
  message?: string;
  [key: string]: unknown;
}

/** Narrows a stream event to a sandbox status update (mirror of activities' `isActivityEvent`). */
export function isSandboxStatus(event: { type: string }): event is SandboxStatus {
  return event.type === "sandbox.status";
}
