import { z } from "zod";
import {
  errorResult,
  okResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { activitiesOf, activityLabel, noticeContent } from "./manager.ts";

const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 300;

const waitArgs = z.strictObject({
  id: z
    .string()
    .describe(
      "An unambiguous name/readable reference from your own activity_list; use its canonical ID only to disambiguate. References expire when collected or after restart.",
    ),
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
    const resolved = mgr.resolve(id);
    if ("error" in resolved) return errorResult(resolved.error);
    id = resolved.id;
    const seconds = timeout_seconds ?? DEFAULT_WAIT_S;
    const outcome = await mgr.wait(id, seconds * 1000, ctx.signal);
    if (outcome === "running") {
      return okResult(
        `activity ${mgr.reference(id)} still running after ${seconds}s; wait again or activity_peek it.`,
      );
    }
    return {
      forModel: noticeContent(id, outcome, mgr.get(id), mgr.reference(id)),
      status: outcome.status,
    };
  }
}

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
export class ActivityKillTool implements Tool<z.infer<typeof killArgs>> {
  readonly essential = true;
  readonly name = "activity_kill";
  readonly description = "Terminate a running activity.";
  readonly input: ToolInput<z.infer<typeof killArgs>> = { kind: "function", schema: killArgs };
  async execute({ id }: z.infer<typeof killArgs>, ctx: ToolContext): Promise<ToolResult> {
    const mgr = activitiesOf(ctx);
    const resolved = mgr.resolve(id);
    if ("error" in resolved) return errorResult(resolved.error);
    id = resolved.id;
    const outcome = mgr.kill(id);
    if (outcome === "unknown") return errorResult(`unknown activity: ${id}`);
    if (outcome === "settled")
      return errorResult(`activity ${mgr.reference(id)} has already completed`);
    return okResult(`requested kill of activity ${mgr.reference(id)}`);
  }
}
