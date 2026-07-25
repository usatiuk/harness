import { z } from "zod";
import {
  errorResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import type { ExecutionContext } from "./context.ts";

export const ESCALATED_PERMISSION = "require_escalated" as const;
export const ESCALATION_PREFIX = "sandbox_permissions=require_escalated\njustification=";
export const ESCALATION_SEPARATOR = "\n---\n";

export interface ExecutionEscalation {
  sandboxPermissions: typeof ESCALATED_PERMISSION;
  justification: string;
}

/** Shared model-facing fields for execution-managed function tools. */
export const executionControlShape = {
  sandbox_permissions: z
    .literal(ESCALATED_PERMISSION)
    .optional()
    .describe("Run this call outside the configured sandbox after approval."),
  justification: z
    .string()
    .optional()
    .describe("Short reason why this call must run outside the configured sandbox."),
};

/** Parse the standardized fields carried by a structured function-tool call. */
export function escalationFromObject(value: unknown): ExecutionEscalation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.sandbox_permissions !== ESCALATED_PERMISSION) return undefined;
  const justification = typeof record.justification === "string" ? record.justification.trim() : "";
  return { sandboxPermissions: ESCALATED_PERMISSION, justification };
}

/**
 * Parse the optional header used by execution-managed custom/freeform tools. Returns the untouched
 * input when no header is present.
 */
export function splitCustomEscalation(raw: string): {
  input: string;
  escalation?: ExecutionEscalation;
} {
  if (!raw.startsWith(ESCALATION_PREFIX)) return { input: raw };
  const separator = raw.indexOf(ESCALATION_SEPARATOR, ESCALATION_PREFIX.length);
  if (separator < 0) {
    return {
      input: raw,
      escalation: { sandboxPermissions: ESCALATED_PERMISSION, justification: "" },
    };
  }
  const justification = raw.slice(ESCALATION_PREFIX.length, separator).trim();
  return {
    input: raw.slice(separator + ESCALATION_SEPARATOR.length),
    escalation: { sandboxPermissions: ESCALATED_PERMISSION, justification },
  };
}

/** The backend-facing request parser used by `classify(call)`. */
export function executionEscalationOf(args: unknown): ExecutionEscalation | undefined {
  if (typeof args === "string") return splitCustomEscalation(args).escalation;
  return escalationFromObject(args);
}

/** Register a tool as genuinely mediated by the selected execution context. */
export function registerExecutionTool(execution: ExecutionContext, name: string): void {
  execution.registerManagedTool?.(name);
}

export function contextWithExecution(ctx: ToolContext, execution: ExecutionContext): ToolContext {
  return {
    ...ctx,
    service: (key) => (key === "execution" ? execution : ctx.service(key)),
  };
}

export function splitStructuredExecutionArgs(value: unknown): {
  args: Record<string, unknown>;
  escalation?: ExecutionEscalation;
  error?: ToolResult;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { args: {}, error: errorResult("invalid execution-managed tool arguments") };
  }
  const { sandbox_permissions, justification, ...args } = value as Record<string, unknown>;
  if (sandbox_permissions === undefined) {
    if (justification !== undefined) {
      return {
        args,
        error: errorResult("justification requires sandbox_permissions=require_escalated"),
      };
    }
    return { args };
  }
  if (sandbox_permissions !== ESCALATED_PERMISSION) {
    return { args, error: errorResult("invalid sandbox_permissions value") };
  }
  const reason = typeof justification === "string" ? justification.trim() : "";
  if (!reason) {
    return { args, error: errorResult("escalated execution requires a justification") };
  }
  return {
    args,
    escalation: { sandboxPermissions: ESCALATED_PERMISSION, justification: reason },
  };
}

/**
 * Mark a function tool as execution-managed. Backends without an escape only record confinement.
 * An escaping backend exposes the real fields in the Zod schema and delegates the original tool
 * with its execution service replaced after approval has let the call reach `execute`.
 */
export function executionFunctionTool(execution: ExecutionContext, tool: Tool): Tool {
  registerExecutionTool(execution, tool.name);
  if (!execution.unconfined) return tool;
  if (tool.input.kind !== "function" || !(tool.input.schema instanceof z.ZodObject)) {
    throw new Error(`execution function tool '${tool.name}' requires an object Zod schema`);
  }

  const input: ToolInput<Record<string, unknown>> = {
    kind: "function",
    schema: tool.input.schema.safeExtend(executionControlShape),
  };
  return {
    name: tool.name,
    description: tool.description,
    input,
    ...(tool.meta ? { meta: tool.meta } : {}),
    async execute(value, ctx) {
      const split = splitStructuredExecutionArgs(value);
      if (split.error) return split.error;
      const selected = split.escalation ? execution.unconfined! : execution;
      return tool.execute(split.args, contextWithExecution(ctx, selected));
    },
  };
}
