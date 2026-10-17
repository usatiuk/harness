import { z } from "zod";
import {
  errorResult,
  okResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { activitiesOf, noticeContent } from "./manager.ts";

const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 300;

const waitArgs = z.strictObject({
  id: z.string(),
  timeout_seconds: z.number().positive().max(MAX_WAIT_S).optional(),
});
export class ActivityWaitTool implements Tool<z.infer<typeof waitArgs>> {
  readonly essential = true;
  readonly name = "activity_wait";
  readonly description =
    "Wait for an activity result when blocked; use this instead of sleep. " +
    `Defaults to ${DEFAULT_WAIT_S} seconds; maximum ${MAX_WAIT_S} seconds per call. ` +
    "A timeout returns 'still running' without stopping the activity.";
  readonly input: ToolInput<z.infer<typeof waitArgs>> = { kind: "function", schema: waitArgs };
  async execute(
    { id, timeout_seconds }: z.infer<typeof waitArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const mgr = activitiesOf(ctx);
    if (!mgr.get(id)) return errorResult(`unknown activity: ${id}`);
    const seconds = timeout_seconds ?? DEFAULT_WAIT_S;
    const outcome = await mgr.wait(id, seconds * 1000, ctx.signal);
    if (outcome === "running") {
      return okResult(
        `activity ${id} still running after ${seconds}s; wait again or activity_peek it.`,
      );
    }
    return { forModel: noticeContent(id, outcome), status: outcome.status };
  }
}

const peekArgs = z.strictObject({ id: z.string(), filter: z.string().optional() });
export class ActivityPeekTool implements Tool<z.infer<typeof peekArgs>> {
  readonly essential = true;
  readonly name = "activity_peek";
  readonly description =
    "Show the latest output of an activity without waiting. Optional `filter` is a regex " +
    "applied per line. For persistent servers or watchers, check readiness here instead of waiting for termination.";
  readonly input: ToolInput<z.infer<typeof peekArgs>> = { kind: "function", schema: peekArgs };
  async execute({ id, filter }: z.infer<typeof peekArgs>, ctx: ToolContext): Promise<ToolResult> {
    const activity = activitiesOf(ctx).get(id);
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
      return `${a.id}  ${result ? result.summary : `running  \`${a.title}\``}`;
    });
    return okResult(lines.join("\n"));
  }
}

const killArgs = z.strictObject({ id: z.string() });
export class ActivityKillTool implements Tool<z.infer<typeof killArgs>> {
  readonly essential = true;
  readonly name = "activity_kill";
  readonly description = "Terminate a running activity.";
  readonly input: ToolInput<z.infer<typeof killArgs>> = { kind: "function", schema: killArgs };
  async execute({ id }: z.infer<typeof killArgs>, ctx: ToolContext): Promise<ToolResult> {
    const outcome = activitiesOf(ctx).kill(id);
    if (outcome === "unknown") return errorResult(`unknown activity: ${id}`);
    if (outcome === "settled") return errorResult(`activity ${id} has already completed`);
    return okResult(`requested kill of activity ${id}`);
  }
}
