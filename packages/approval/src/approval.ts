import {
  errorResult,
  InteractionTimeoutError,
  type ConfigReader,
  type PluginDefinition,
  type ToolCall,
  type ToolHandler,
  type ToolMiddleware,
  type ToolMiddlewareContext,
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
  type ToolPermission,
} from "./presentation.ts";

function effectFor(
  config: ApprovalConfig,
  tool: string,
  relationship: Relationship,
): ToolPermission {
  const base = relationship === "in-workspace" ? config.inWorkspace : config.outOfWorkspace;
  const override = Object.hasOwn(config.tools, tool) ? config.tools[tool] : undefined;
  if (override === undefined) return base;
  if (typeof override === "string") return override;
  return (relationship === "in-workspace" ? override.inWorkspace : override.outOfWorkspace) ?? base;
}

/** Shared execution of a tool permission; callers own how that permission was selected. */
export function createToolApproval(reader: ConfigReader) {
  return async (
    permission: ToolPermission,
    call: ToolCall,
    ctx: ToolMiddlewareContext,
    next: ToolHandler,
    relationship?: Relationship,
  ) => {
    if (permission === "allow") return next(call);
    const facts = relationship === undefined ? {} : { relationship };
    let answer: ApprovalResponse;
    if (permission === "deny") {
      const reason = `denied by policy${relationship ? ` (${relationship})` : ""}`;
      ctx.setResultAnnotation("approval", {
        decision: "deny",
        responder: "policy",
        ...facts,
        reason,
      });
      return errorResult(`tool '${call.name}' ${reason}`);
    }
    const config = approvalConfigSchema.parse(await reader.get("approval", ctx.conversationId));
    const contract = ctx.toolContract(call.name);
    const request: ApprovalRequest = {
      kind: "approval",
      call,
      ...facts,
      ...(permission === "ask-human" ? { allowAutoApproval: false } : {}),
      ...(contract ? { description: contract.input.description, input: contract.input } : {}),
    };
    try {
      const parsed = approvalResponseSchema.safeParse(
        await ctx.request(request, {
          timeoutMs: config.humanApprovalTimeoutSeconds * 1000,
        }),
      );
      answer = parsed.success
        ? (parsed.data as ApprovalResponse)
        : {
            decision: "deny",
            responder: "human",
            reason: "invalid approval response",
          };
    } catch (error) {
      if (!(error instanceof InteractionTimeoutError)) throw error;
      answer = { decision: "deny", responder: "human", reason: "human approval timed out" };
    }
    const responder = answer.responder ?? "human";
    const approval: ApprovalAnnotation = {
      decision: answer.decision,
      responder,
      ...facts,
      ...(answer.reason ? { reason: answer.reason } : {}),
      ...(answer.model ? { model: answer.model } : {}),
    };
    ctx.setResultAnnotation("approval", approval);
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
      return errorResult(
        `tool '${call.name}' denied${responder === "auto" ? " by auto-approval" : ""}: ${reason}`,
      );
    }
    return next(call);
  };
}

/** Composition can route tools with their own policy selector to the same approval mechanism. */
export function createApprovalPlugin(
  handlesTool: (name: string) => boolean = () => true,
): PluginDefinition {
  return {
    id: "approval",
    configSchema: approvalConfigSchema,
    create(reader) {
      const approve = createToolApproval(reader);
      const middleware: ToolMiddleware = {
        id: "approval",
        async wrap(call, ctx, next) {
          if (ctx.codeTools || !handlesTool(call.name)) return next(call);
          const config = approvalConfigSchema.parse(
            await reader.get("approval", ctx.conversationId),
          );
          const relationship: Relationship = ctx.service("execution")
            ? executionOf(ctx).classify(call)
            : "unknown";
          return approve(effectFor(config, call.name, relationship), call, ctx, next, relationship);
        },
      };
      return { id: "approval", toolMiddleware: () => [middleware] };
    },
  };
}
export const approvalPlugin = createApprovalPlugin();
