import { errorResult, okResult, type Tool, type ToolContext } from "@harness/protocol";
import type { z } from "zod";
import type { SubagentsDefinition } from "./plugin.ts";
import { subagentArgs, SpawnRejected } from "./spawn.ts";

/**
 * Launch a child conversation and return its identity, not its eventual result.
 */
export class SubagentTool implements Tool<z.infer<typeof subagentArgs>> {
  readonly essential = true;
  readonly name = "subagent";
  readonly description =
    "Delegate a focused task to a specialized subagent that runs in its own conversation with its " +
    "own system prompt and tool scope. Returns the child's identity after launch; its turn result arrives separately. Do small, quick work directly. " +
    "Delegate substantive independent work when isolation or useful parallelism helps. " +
    "Do not relay your unchanged assigned task to another agent.";
  readonly input = { kind: "function" as const, schema: subagentArgs };
  constructor(private readonly definition: SubagentsDefinition) {}

  async execute(args: z.infer<typeof subagentArgs>, ctx: ToolContext) {
    try {
      const child = await this.definition.spawn({
        ...args,
        parent: ctx.conversationId,
        callId: ctx.callId,
        signal: ctx.signal,
      });
      return { ...okResult(`Started ${child.name} [${child.slug}].`), structured: child };
    } catch (cause) {
      if (cause instanceof SpawnRejected) return errorResult(cause.message);
      throw cause;
    }
  }
}
