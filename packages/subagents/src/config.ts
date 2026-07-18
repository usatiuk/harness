import { z } from "zod";

const modelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.string().optional(),
});

/** One delegatable agent in the catalog. */
export const agentDefSchema = z.object({
  /** Short identifier the parent passes to the `subagent` tool. */
  name: z.string(),
  /** Parent-facing: when the parent should pick this agent (listed in the tool's description). */
  description: z.string(),
  /** Child-facing: the subagent's own system prompt. */
  systemPrompt: z.string(),
  /** The child's tool scope (tool names). Absent ⇒ the child is unrestricted (all tools). */
  tools: z.object({ allow: z.array(z.string()) }).optional(),
  /** The child's model. Absent ⇒ inherits the parent's resolved model. */
  model: modelConfigSchema.optional(),
});
export type AgentDef = z.infer<typeof agentDefSchema>;

/**
 * Agents shipped out of the box — the `.default()` of `agents`, shown when the field is unset.
 * Setting `agents` replaces them entirely (redeclare a built-in to keep it); no merge logic.
 */
export const DEFAULT_AGENTS: AgentDef[] = [
  {
    name: "general",
    description: "Any self-contained subtask — a fresh, isolated context to plan, act, and verify.",
    systemPrompt:
      "You are a general-purpose coding agent. Complete the assigned task autonomously using the " +
      "available tools: make a plan, carry it out, verify the result, then report a concise summary.",
  },
  {
    name: "explore",
    description:
      "Read-only investigation — map an area or answer a question, without modifying files.",
    systemPrompt:
      "You are a read-only research agent. Use glob to locate files, read_file to inspect them, " +
      "and the available bash or powershell tool only for read-only content searches. Do NOT use " +
      "commands that modify, create, or delete files. Report findings concisely with file:line " +
      "references.",
    // Only the substrate's active command tool is offered; its calls remain approval-gated.
    tools: { allow: ["read_file", "glob", "bash", "powershell"] },
  },
];

/** The recursion floor; a child at this depth is a leaf (cannot spawn). */
export const DEFAULT_MAX_DEPTH = 3;

/**
 * The `plugins.subagents` settings slice: the agent catalog (resolved per-conversation via the
 * cascade) and the recursion limit. Per-instance parentage is NOT here — it's metadata in `plugin_state`.
 */
export const subagentsConfigSchema = z.object({
  agents: z.array(agentDefSchema).default(DEFAULT_AGENTS),
  maxDepth: z.number().int().positive().default(DEFAULT_MAX_DEPTH),
});
export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;
