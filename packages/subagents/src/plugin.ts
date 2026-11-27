import type { ZodType } from "zod";
import { activitiesOf } from "@harness/activities";
import type {
  TurnStartContext,
  ConfigReader,
  ConversationRunner,
  ToolContractResolver,
  Plugin,
  PluginDefinition,
  ToolSchema,
} from "@harness/protocol";
import { subagentsConfigSchema, type AgentDef, type SubagentsConfig } from "./config.ts";
import { createSpawnOperation, type SpawnRequest } from "./spawn.ts";
import { SubagentDismissTool, SubagentListTool, SubagentSendTool } from "./messages.ts";
import { SubagentTool } from "./tool.ts";
import { SubagentActivity } from "./activity.ts";
import { spawnMark } from "./family.ts";

/** Renders the catalog as the parent-facing roster appended to the tool description / `agent` arg. */
function roster(agents: AgentDef[]): string {
  return agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}

/**
 * At the turn boundary, enriches the `subagent` contract from the conversation's catalog: constrains `agent`
 * to configured names and appends the roster. Drops the tool when no agents are configured, so the
 * model never sees a callable it can't use. Declarations and discovery share this turn's contract.
 */
export function subagentContractResolver(reader: ConfigReader): ToolContractResolver {
  return async (contract, ctx) => {
    if (contract.input.name !== "subagent") return contract;
    const cfg = (await reader.get<SubagentsConfig>("subagents", ctx.conversationId)) ?? {};
    const agents = cfg.agents ?? [];
    return agents.length === 0 ? null : { ...contract, input: withRoster(contract.input, agents) };
  };
}

/** Constrain the agent name and include its description in the tool catalog. */
function withRoster(tool: ToolSchema, agents: AgentDef[]): ToolSchema {
  if (tool.kind !== "function") return tool;
  const params = tool.parameters;
  const properties = { ...(params.properties as Record<string, unknown>) };
  const list = roster(agents);
  properties.agent = {
    type: "string",
    enum: agents.map((a) => a.name),
    description: `The agent to delegate to.\n${list}`,
  };
  return {
    ...tool,
    description: `${tool.description}\n\nAvailable agents:\n${list}`,
    parameters: { ...params, properties },
  };
}

/** Service-owned catalog and spawn admission, shared by tools and programmatic callers. */
export class SubagentsDefinition implements PluginDefinition {
  readonly id = "subagents";
  readonly configSchema: ZodType = subagentsConfigSchema;
  #spawn?: ReturnType<typeof createSpawnOperation>;

  constructor(private readonly runner: () => ConversationRunner) {}

  create(reader: ConfigReader): Plugin {
    if (this.#spawn) throw new Error("Subagents definition already registered");
    this.#spawn = createSpawnOperation(reader, this.runner);
    return {
      id: this.id,
      tools: () => [
        new SubagentListTool(this.runner),
        new SubagentDismissTool(this.runner),
        new SubagentSendTool(this.runner),
        new SubagentTool(this),
      ],
      onTurnStart: (ctx) => this.#trackTurn(ctx),
      toolContracts: () => [subagentContractResolver(reader)],
    };
  }

  async #trackTurn({ conversation, turnId }: TurnStartContext) {
    const parentId = conversation.parentId;
    if (!parentId) return;
    const runner = this.runner();
    const mark = await spawnMark(runner, conversation.id);
    if (!mark) return;
    if (mark.parent.conversationId !== parentId) throw new Error("Subagent parent mismatch");
    const owner = await runner.scope(parentId, this.id);
    const manager = activitiesOf(owner);
    manager.track(
      new SubagentActivity({
        runner,
        childId: conversation.id,
        turnId,
        title: mark.name ?? mark.agent,
        reference: mark.slug ?? conversation.id,
      }),
      { emit: owner.emit },
    );
    manager.notifyOnExit(turnId, owner.deliver);
  }

  spawn(request: SpawnRequest) {
    if (!this.#spawn) throw new Error("Subagents definition is not registered");
    return this.#spawn(request);
  }
}
