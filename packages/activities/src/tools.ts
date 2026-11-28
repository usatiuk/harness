import { z } from "zod";
import {
  errorResult,
  okResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { activitiesOf, activityLabel } from "./manager.ts";

const activityId = z
  .string()
  .describe("Activity ID. Subagents also accept an unambiguous caller-owned name or reference.");
const peekArgs = z.strictObject({
  id: activityId,
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
    const content = activity.peek(filter ? { filter } : undefined);
    return {
      ...(activity.preserveModelView && { preserveModelView: true }),
      forModel:
        activity.reference === undefined
          ? [{ type: "text", text: `${activityLabel(activity, activity.id)}\n` }, ...content]
          : content,
      status: "ok",
    };
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
      return `${activityLabel(a, mgr.reference(a.id))}  ${result?.summary ?? "running"}`;
    });
    return okResult(lines.join("\n"));
  }
}

const killArgs = z.strictObject({
  id: activityId,
});
export class ActivityKillTool implements Tool<z.infer<typeof killArgs>> {
  readonly essential = true;
  readonly name = "activity_kill";
  readonly description = "Stop a running activity owned by this conversation.";
  readonly input: ToolInput<z.infer<typeof killArgs>> = { kind: "function", schema: killArgs };
  async execute({ id }: z.infer<typeof killArgs>, ctx: ToolContext): Promise<ToolResult> {
    const mgr = activitiesOf(ctx);
    const resolved = mgr.resolve(id);
    if ("error" in resolved) return errorResult(resolved.error);
    const label = mgr.reference(resolved.id);
    switch (mgr.kill(resolved.id)) {
      case "requested":
        return okResult(`requested kill of activity ${label}`);
      case "settled":
        return errorResult(`activity ${label} has already completed`);
      case "unknown":
        throw new Error(`Resolved activity '${resolved.id}' is not tracked`);
    }
  }
}
