import { z } from "zod";
import {
  errorResult,
  okResult,
  type ConfigReader,
  type ConversationOverrides,
  type ConversationRunner,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { activitiesOf } from "@harness/activities";
import { DEFAULT_MAX_DEPTH, type SubagentsConfig } from "./config.ts";
import { depthOf, type SubagentRegistry } from "./registry.ts";
import { isDismissed, rosterPage } from "./family.ts";
import { spawnSubagent } from "./activity.ts";

const subagentArgs = z.strictObject({
  agent: z.string().describe("The agent to delegate to (one of the catalog names)."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("A short readable name for this task, e.g. Review authentication."),
  slug: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe(
      "A stable kebab-case task identifier, unique within this parent conversation, e.g. auth-review.",
    ),
  task: z.string().describe("The task for the subagent — its full prompt for this delegation."),
});

export interface SubagentToolDeps {
  /** Reads the resolved `plugins.subagents` catalog for the dispatching conversation. */
  reader: ConfigReader;
  /** Lazy: the runner is bound after the service is constructed, but before any tool runs. */
  runner: () => ConversationRunner;
  /** Live child index for cascade-stop. */
  registry: SubagentRegistry;
}

/**
 * `subagent({ agent, name, slug, task })` — delegates to a child conversation with its own scope, returning
 * the child's final output. Recursion depth is bounded by a spawn-time check.
 */
export class SubagentTool implements Tool<z.infer<typeof subagentArgs>> {
  readonly essential = true;
  readonly name = "subagent";
  readonly description =
    "Delegate a focused task to a specialized subagent that runs in its own conversation with its " +
    "own system prompt and tool scope, then returns its final output. Prefer this for self-contained " +
    "subtasks (research, a bounded refactor, a test sweep) over doing it inline.";
  readonly input: ToolInput<z.infer<typeof subagentArgs>> = {
    kind: "function",
    schema: subagentArgs,
  };
  readonly meta = { backgroundable: true };
  readonly #deps: SubagentToolDeps;

  constructor(deps: SubagentToolDeps) {
    this.#deps = deps;
  }

  async execute(
    { agent: agentName, name, slug, task }: z.infer<typeof subagentArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const runner = this.#deps.runner();
    const cfg = await this.#deps.reader.get<SubagentsConfig>("subagents", ctx.conversationId);
    const maxDepth = cfg.maxDepth ?? DEFAULT_MAX_DEPTH;
    const agents = cfg.agents ?? [];
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
      const known = agents.map((a) => a.name).join(", ") || "(none configured)";
      return errorResult(`unknown agent: ${agentName}. Available: ${known}`);
    }

    // Single spawn-time check: withholding `subagent` from an unrestricted child can't be
    // expressed ("all tools minus one" needs the global surface the tool can't see), so refuse here.
    const parentDepth = await depthOf(runner, ctx.conversationId, maxDepth);
    if (parentDepth >= maxDepth) {
      return errorResult(`subagent depth limit reached (max ${maxDepth})`);
    }
    const childAllow = agent.tools?.allow;

    const overrides: ConversationOverrides = { instructions: agent.systemPrompt };
    if (agent.model) overrides.model = agent.model;
    if (childAllow) overrides.tools = { allow: childAllow };

    // Spawn the child in the parent's project (shared cwd ⇒ same settings cascade + catalog).
    const parent = await runner.getConversation(ctx.conversationId);
    const cwd = parent?.workspaceRoot ?? undefined;
    return this.#deps.registry.withSpawn(ctx.conversationId, async () => {
      ctx.signal.throwIfAborted();
      if (await isDismissed(runner, ctx.conversationId))
        return errorResult("Dismissed subagents cannot spawn children.");
      const maxChildren = cfg.maxChildren ?? 3;
      if ((await rosterPage(runner, ctx.conversationId, maxChildren)).length >= maxChildren)
        return errorResult(
          `Subagent limit reached (${maxChildren} active children). Dismiss a child before spawning another.`,
        );
      if (
        (await runner.getPluginState("subagents", ctx.conversationId, `slug:${slug}`)) !== undefined
      )
        return errorResult(`subagent slug already exists: ${slug}`);
      const activity = await spawnSubagent({
        runner,
        parent: ctx.conversationId,
        callId: ctx.callId,
        agentName: agent.name,
        name,
        slug,
        task,
        overrides,
        ...(cwd !== undefined ? { cwd } : {}),
      });

      this.#deps.registry.track(ctx.conversationId, activity.childId);
      activitiesOf(ctx).track(activity, { callId: ctx.callId, emit: (e) => ctx.emit(e) });
      // Placeholder; the activities consumption middleware claims this activity and owns the real
      // model-facing result (the child's final output, foreground or backgrounded).
      return okResult(`started subagent ${name} [${slug}] (${activity.id})`);
    });
  }
}
