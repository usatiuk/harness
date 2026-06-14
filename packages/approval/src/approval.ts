import { z } from "zod";
import {
  errorResult,
  type ConfigReader,
  type PluginDefinition,
  type ToolMiddleware,
} from "@harness/protocol";
import { executionOf, type Relationship } from "@harness/execution";

const effect = z.enum(["allow", "ask", "deny"]);
const toolRule = z.union([
  effect,
  z.strictObject({ inWorkspace: effect.optional(), outOfWorkspace: effect.optional() }),
]);

/**
 * Approval as attribute-based policy: the substrate emits a `relationship`, config
 * maps `(tool, relationship) → effect`. The defaults give the v0 behaviour — act
 * freely inside the workspace, ask before reaching outside it (and `bash`, which has
 * no in-workspace path, is always "outside" → asks). A per-tool entry overrides the
 * relationship default; most-specific wins.
 */
export const approvalConfigSchema = z.strictObject({
  inWorkspace: effect.default("allow"),
  outOfWorkspace: effect.default("ask"),
  tools: z.record(z.string(), toolRule).default({}),
});

export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;
type Effect = z.infer<typeof effect>;

/** Resolves the effect for a call: per-tool override (by relationship) beats the relationship default. */
function effectFor(config: ApprovalConfig, tool: string, relationship: Relationship): Effect {
  const base = relationship === "in-workspace" ? config.inWorkspace : config.outOfWorkspace;
  const override = config.tools[tool];
  if (override === undefined) return base;
  if (typeof override === "string") return override;
  return (relationship === "in-workspace" ? override.inWorkspace : override.outOfWorkspace) ?? base;
}

function approvalMiddleware(reader: ConfigReader): ToolMiddleware {
  return {
    id: "approval",
    async wrap(call, ctx, next) {
      const config = approvalConfigSchema.parse(await reader.get("approval", ctx.conversationId));
      const relationship: Relationship = ctx.service("execution")
        ? executionOf(ctx).classify(call)
        : "out-of-workspace";
      const decision = effectFor(config, call.name, relationship);
      if (decision === "allow") return next(call);
      if (decision === "deny") {
        return errorResult(`tool '${call.name}' denied by policy (${relationship})`);
      }
      const answer = (await ctx.request({ kind: "approval", call, relationship })) as {
        decision?: string;
      };
      return answer.decision === "deny" ? errorResult(`tool '${call.name}' denied`) : next(call);
    },
  };
}

/** Gates tool calls by `(tool, relationship) → allow | ask | deny`, configured under `plugins.approval`. */
export const approvalPlugin: PluginDefinition = {
  id: "approval",
  configSchema: approvalConfigSchema,
  create(reader) {
    return { id: "approval", toolMiddleware: () => [approvalMiddleware(reader)] };
  },
};
