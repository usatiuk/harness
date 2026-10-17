import type { ZodType } from "zod";
import type {
  ConfigReader,
  ConversationRunner,
  ToolContractResolver,
  Plugin,
  PluginDefinition,
  ToolSchema,
} from "@harness/protocol";
import { subagentsConfigSchema, type AgentDef, type SubagentsConfig } from "./config.ts";
import { SubagentRegistry } from "./registry.ts";
import { SubagentDismissTool, SubagentListTool, SubagentSendTool } from "./messages.ts";
import { SubagentTool } from "./tool.ts";

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

/** Constrain `agent` to an enum of names + append the roster; preserves any injected `background`. */
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

/** The composed subagents plugin: one generic tool and its turn-local contract resolver. */
class SubagentsPlugin implements Plugin {
  readonly id = "subagents";
  readonly #reader: ConfigReader;
  readonly #def: SubagentsDefinition;

  constructor(reader: ConfigReader, def: SubagentsDefinition) {
    this.#reader = reader;
    this.#def = def;
  }

  tools() {
    return [
      new SubagentListTool(() => this.#def.runner()),
      new SubagentDismissTool(() => this.#def.runner()),
      new SubagentSendTool(() => this.#def.runner()),
      new SubagentTool({
        reader: this.#reader,
        runner: () => this.#def.runner(),
        registry: this.#def.registry,
      }),
    ];
  }

  toolContracts() {
    return [subagentContractResolver(this.#reader)];
  }
}

/**
 * Config-owning definition for the `plugins.subagents` slice. The catalog (agents/maxDepth) is
 * validated centrally and reaches the plugin via the `ConfigReader`; the runner is late-bound at
 * the composition root (`bindRunner`) since the service isn't constructed when the plugin is built.
 */
export class SubagentsDefinition implements PluginDefinition {
  readonly id = "subagents";
  readonly configSchema: ZodType = subagentsConfigSchema;
  readonly registry = new SubagentRegistry();
  #runner: ConversationRunner | undefined;

  create(reader: ConfigReader): Plugin {
    return new SubagentsPlugin(reader, this);
  }

  /** Late-bind the runner; called once at the composition root, after the service is constructed. */
  bindRunner(runner: ConversationRunner): void {
    this.#runner = runner;
  }

  /** The bound runner; throws if read before `bindRunner` (i.e. before any tool could run). */
  runner(): ConversationRunner {
    if (!this.#runner) {
      throw new Error(
        "subagents: runner not bound — call bindRunner after constructing the service",
      );
    }
    return this.#runner;
  }

  /** Drop process-local parentage after the engine has deactivated the complete conversation tree. */
  resetSession(): void {
    this.registry.clear();
  }
}

export const subagentsDefinition = new SubagentsDefinition();
