import { z } from "zod";
import {
  errorResult,
  type ConfigReader,
  type PluginDefinition,
  type ToolMiddleware,
} from "@harness/protocol";
import { executionOf, type Relationship } from "@harness/execution";
import type { HarnessEvent, InteractionRequest, ModelConfig, ToolCall } from "@harness/protocol";

const effect = z.enum(["allow", "ask", "deny"]);
const toolRule = z.union([
  effect,
  z.strictObject({ inWorkspace: effect.optional(), outOfWorkspace: effect.optional() }),
]);

/**
 * Approval as attribute-based policy: the substrate emits a `relationship`, config
 * maps `(tool, relationship) → effect`. The defaults give the v0 behaviour — act
 * freely inside the workspace, ask before reaching outside it or when scope is unknown.
 * `unknown` deliberately inherits the out-of-workspace rule, preserving one conservative
 * configuration path for command and custom-shaped tools. A per-tool entry overrides the
 * relationship default; most-specific wins.
 */
export const approvalConfigSchema = z.strictObject({
  inWorkspace: effect.default("allow"),
  outOfWorkspace: effect.default("ask"),
  tools: z.record(z.string(), toolRule).default({}),
});

export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;
type Effect = z.infer<typeof effect>;

export interface ApprovalRequest extends InteractionRequest {
  kind: "approval";
  call: ToolCall;
  relationship: Relationship;
}

export type ApprovalResponder = "auto" | "human" | "policy";

export interface ApprovalResponse {
  decision: "allow" | "deny";
  responder?: Exclude<ApprovalResponder, "policy">;
  reason?: string;
  model?: ModelConfig;
}

export interface ApprovalAnnotation {
  decision: "allow" | "deny";
  responder: ApprovalResponder;
  relationship: Relationship;
  reason?: string;
  model?: ModelConfig;
}

export interface ApprovalDecidedEvent {
  type: "approval.decided";
  conversationId?: string;
  callId: string;
  decision: "allow" | "deny";
  responder: ApprovalResponder;
  model?: ModelConfig;
  reason?: string;
}

export const isApprovalDecidedEvent = (
  event: HarnessEvent,
): event is HarnessEvent & ApprovalDecidedEvent => event.type === "approval.decided";

const approvalResponseSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  responder: z.enum(["auto", "human"]).optional(),
  reason: z.string().optional(),
  model: z
    .object({ provider: z.string(), model: z.string(), preset: z.string().optional() })
    .optional(),
});

const approvalAnnotationSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  responder: z.enum(["auto", "human", "policy"]),
  relationship: z.enum(["in-workspace", "out-of-workspace", "unknown"]),
  reason: z.string().optional(),
  model: z
    .object({ provider: z.string(), model: z.string(), preset: z.string().optional() })
    .optional(),
});

export const isApprovalRequest = (request: unknown): request is ApprovalRequest => {
  if (!request || typeof request !== "object") return false;
  const value = request as Partial<ApprovalRequest>;
  return (
    value.kind === "approval" &&
    !!value.call &&
    typeof value.call.name === "string" &&
    typeof value.call.callId === "string" &&
    (value.relationship === "in-workspace" ||
      value.relationship === "out-of-workspace" ||
      value.relationship === "unknown")
  );
};

export const approvalAnnotationOf = (
  annotations: Record<string, unknown> | undefined,
): ApprovalAnnotation | undefined => {
  const value = annotations?.["approval"];
  const parsed = approvalAnnotationSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    decision: parsed.data.decision,
    responder: parsed.data.responder,
    relationship: parsed.data.relationship,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    ...(parsed.data.model
      ? {
          model: {
            provider: parsed.data.model.provider,
            model: parsed.data.model.model,
            ...(parsed.data.model.preset ? { preset: parsed.data.model.preset } : {}),
          },
        }
      : {}),
  };
};

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
