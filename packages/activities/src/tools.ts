import { z } from "zod";
import {
  errorResult,
  okResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { activitiesOf, activityLabel, type ActivityManager } from "./manager.ts";

const peekArgs = z.strictObject({
  id: z.string().describe("Caller-owned unambiguous name/reference, or canonical ID fallback."),
  filter: z.string().optional(),
});
export class ActivityPeekTool implements Tool<z.infer<typeof peekArgs>> {
  readonly essential = true;
  readonly name = "activity_peek";
  readonly description =
    "Show the latest output of an activity without waiting. Optional `filter` is a regex " +
    "applied per line. For persistent servers or watchers, check readiness here instead of waiting for termination.";
  readonly input: ToolInput<z.infer<typeof peekArgs>> = { kind: "function", schema: peekArgs };
  async execute({ id, filter }: z.infer<typeof peekArgs>, ctx: ToolContext): Promise<ToolResult> {
    const mgr = activitiesOf(ctx);
    const resolved = mgr.resolve(id);
    if ("error" in resolved) return errorResult(resolved.error);
    const activity = mgr.get(resolved.id);
    if (!activity) return errorResult(`unknown activity: ${id}`);
    return { forModel: activity.peek(filter ? { filter } : undefined), status: "ok" };
  }
}

export class ActivityListTool implements Tool<Record<string, never>> {
  readonly essential = true;
  readonly name = "activity_list";
  readonly description = "List this conversation's activities with their status.";
  readonly input: ToolInput<Record<string, never>> = {
    kind: "function",
    schema: z.strictObject({}),
  };
  async execute(_args: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const mgr = activitiesOf(ctx);
    const activities = mgr.list();
    if (activities.length === 0) return okResult("no activities");
    const lines = activities.map((a) => {
      const result = mgr.resultOf(a.id);
      return `${activityLabel(a, mgr.reference(a.id))}  ${result ? result.summary : `running  \`${a.title}\``}`;
    });
    return okResult(lines.join("\n"));
  }
}

const killArgs = z.strictObject({
  id: z.string().describe("Caller-owned unambiguous name/reference, or canonical ID fallback."),
});
/** Provided by the subagents plugin: the child thread outlives its original activity handle. */
export interface SubagentThreadCloser {
  close(reference: string, signal: AbortSignal): Promise<{ id: string } | { error: string }>;
}
export const SUBAGENT_THREAD_CLOSER = "subagents.threadCloser";

/** Explicit stop (RPC or tool), unlike activation teardown, permanently closes owned threads. */
export async function killOwnedActivity(
  manager: ActivityManager | undefined,
  id: string,
  closer: SubagentThreadCloser | undefined,
  signal: AbortSignal,
): Promise<{ status: "requested" | "settled" | "unknown"; message: string }> {
  const activity = manager?.get(id);
  if (!activity || activity.kind === "subagent") {
    if (closer) {
      const result = await closer.close(id, signal);
      return "error" in result
        ? { status: "unknown", message: result.error }
        : { status: "requested", message: `Stopped subagent ${id} and its subtree.` };
    }
    if (activity) throw new Error("Tracked subagent has no thread closer");
    return { status: "unknown", message: `unknown activity: ${id}` };
  }
  const status = manager!.kill(id);
  const label = manager!.reference(id);
  return {
    status,
    message:
      status === "settled"
        ? `activity ${label} has already completed`
        : `requested kill of activity ${label}`,
  };
}
export class ActivityKillTool implements Tool<z.infer<typeof killArgs>> {
  readonly essential = true;
  readonly name = "activity_kill";
  readonly description =
    "Terminate a running activity, or permanently close a direct subagent and its subtree, even after its original task completed.";
  readonly input: ToolInput<z.infer<typeof killArgs>> = { kind: "function", schema: killArgs };
  async execute({ id }: z.infer<typeof killArgs>, ctx: ToolContext): Promise<ToolResult> {
    const mgr = activitiesOf(ctx);
    const resolved = mgr.resolve(id);
    if ("error" in resolved && resolved.reason === "ambiguous") return errorResult(resolved.error);
    const closer = ctx.service(SUBAGENT_THREAD_CLOSER) as SubagentThreadCloser | undefined;
    const outcome = await killOwnedActivity(
      mgr,
      "id" in resolved ? resolved.id : id,
      closer,
      ctx.signal,
    );
    return outcome.status === "requested"
      ? okResult(outcome.message)
      : errorResult(outcome.message);
  }
}
