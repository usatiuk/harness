import {
  okResult,
  type ToolContractResolver,
  type ToolContext,
  type ToolMiddleware,
  type ToolResult,
  type ToolSchema,
} from "@harness/protocol";
import type { Activity } from "./activity.ts";
import { ActivityManager, noticeContent } from "./manager.ts";

/** How long a default (foreground) activity may block the turn before auto-backgrounding. */
const FOREGROUND_MS = 10_000;

/** Model-facing result for a just-started activity: foreground inlines or auto-backgrounds; background notifies on exit. */
export async function consume(
  mgr: ActivityManager,
  activity: Activity,
  background: boolean,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (background) return backgroundNotice(mgr, activity, ctx, true);
  // The process was spawned unbound from `ctx.signal`; the foreground wait owns interrupt → kill.
  const onAbort = (): void => activity.kill();
  // Already interrupted: a late `abort` listener won't fire, so kill now.
  if (ctx.signal.aborted) activity.kill();
  else ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = await mgr.wait(activity.id, FOREGROUND_MS, ctx.signal);
    if (outcome === "running") return backgroundNotice(mgr, activity, ctx, false);
    return {
      forModel: noticeContent(activity.id, outcome),
      status: outcome.status,
      structured: {
        activityId: activity.id,
        state: "completed",
        status: outcome.status,
        content: noticeContent(activity.id, outcome),
      },
    };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

/** Persist + arm the completion notice + return a "running in the background" status. */
function backgroundNotice(
  mgr: ActivityManager,
  activity: Activity,
  ctx: ToolContext,
  immediate: boolean,
): ToolResult {
  activity.persist?.();
  mgr.notifyOnExit(activity.id, (content) => ctx.deliver(content));
  const lead = immediate
    ? `Started activity ${activity.id} (${activity.title}) in the background.`
    : `Activity ${activity.id} (${activity.title}) is still running; left in the background.`;
  return {
    ...okResult(
      `${lead} You'll get a one-shot completion notice, ` +
        `or use activity_wait / activity_peek / activity_kill with id ${activity.id}.`,
    ),
    structured: { activityId: activity.id, state: "running", title: activity.title },
  };
}

/**
 * Dispatch end of the consumption pair: strips the injected `background` arg before the tool's
 * strict schema validates, runs the tool (which mints + `track`s its activity under `call.callId`),
 * then `claim`s it. No activity claimed ⇒ an ordinary tool ⇒ pass the result straight through.
 */
export function consumeMiddleware(): ToolMiddleware {
  return {
    id: "activity-consume",
    async wrap(call, ctx, next) {
      let background = false;
      let forwarded = call;
      if (call.args && typeof call.args === "object" && "background" in call.args) {
        const { background: flag, ...rest } = call.args as Record<string, unknown>;
        background = flag === true;
        forwarded = { ...call, args: rest };
      }
      const result = await next(forwarded);
      const mgr = ctx.service("activities");
      const activity = mgr instanceof ActivityManager ? mgr.claim(call.callId) : undefined;
      if (!(mgr instanceof ActivityManager) || !activity) return result;
      return consume(mgr, activity, background, ctx);
    },
  };
}

/**
 * Schema end of the pair: injects a uniform `background` boolean into the wire schema of every
 * `backgroundable` tool (keyed off the opaque `meta` bag via `ctx.toolMeta`), so the model can pick
 * foreground vs background without each tool author writing the arg. Tool meta never reaches the
 * provider; only `function`-kind tools have a JSON-schema slot.
 */
export function backgroundContractResolver(): ToolContractResolver {
  return (contract, ctx) =>
    contract.input.kind === "function" && ctx.toolMeta(contract.input.name)?.backgroundable
      ? { ...contract, input: withBackground(contract.input) }
      : contract;
}

function withBackground(tool: Extract<ToolSchema, { kind: "function" }>): ToolSchema {
  const params = tool.parameters as { properties?: Record<string, unknown> };
  const properties = {
    ...(params.properties ?? {}),
    background: {
      type: "boolean",
      description:
        "Run in the background instead of waiting for it to finish. Use for dev servers, " +
        "watchers, or long builds; you'll be notified on completion and can " +
        "activity_wait / activity_peek / activity_kill it.",
    },
  };
  return { ...tool, parameters: { ...tool.parameters, properties } };
}
