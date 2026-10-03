import {
  errorResult,
  type ConfigReader,
  type PluginDefinition,
  type ToolMiddleware,
} from "@harness/protocol";
import { executionOf, type Relationship } from "@harness/execution";

export * from "./presentation.ts";
import {
  approvalConfigSchema,
  approvalResponseSchema,
  type ApprovalConfig,
  type ApprovalAnnotation,
  type ApprovalRequest,
  type ApprovalResponse,
} from "./presentation.ts";
type Effect = ApprovalConfig["inWorkspace"];

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
        : "unknown";
      const decision = effectFor(config, call.name, relationship);
      if (decision === "allow") return next(call);
      if (decision === "deny") {
        const reason = `denied by policy (${relationship})`;
        ctx.setResultAnnotation("approval", {
          decision: "deny",
          responder: "policy",
          relationship,
          reason,
        });
        return errorResult(`tool '${call.name}' ${reason}`);
      }
      const request: ApprovalRequest = { kind: "approval", call, relationship };
      const parsed = approvalResponseSchema.safeParse(await ctx.request(request));
      const answer: ApprovalResponse = parsed.success
        ? (parsed.data as ApprovalResponse)
        : {
            decision: "deny",
            responder: "human",
            reason: "invalid approval response",
          };
      const responder = answer.responder ?? "human";
      const approval: ApprovalAnnotation = {
        decision: answer.decision,
        responder,
        relationship,
        ...(answer.reason ? { reason: answer.reason } : {}),
        ...(answer.model ? { model: answer.model } : {}),
      };
      ctx.setResultAnnotation("approval", approval);
      // Emit only after the annotation is captured, so an observer-triggered
      // interrupt cannot outrun the durable result metadata.
      ctx.emit({
        type: "approval.decided",
        callId: call.callId,
        decision: answer.decision,
        responder,
        ...(answer.model ? { model: answer.model } : {}),
        ...(answer.reason ? { reason: answer.reason } : {}),
      });
      if (answer.decision === "deny") {
        const reason = answer.reason ?? `denied by ${responder === "human" ? "user" : responder}`;
        const by = responder === "auto" ? " by auto-approval" : "";
        return errorResult(`tool '${call.name}' denied${by}: ${reason}`);
      }
      return next(call);
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
