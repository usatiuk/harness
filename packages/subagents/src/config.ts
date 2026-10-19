import { z } from "zod";

const modelConfigSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  preset: z.string().optional(),
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
    description:
      "Substantive independent work — a fresh, isolated context to plan, act, and verify; do small work directly.",
    systemPrompt:
      "You are a general-purpose coding agent. Complete the assigned task autonomously using the " +
      "available tools: make a plan, carry it out, verify the result, then report a concise summary. Do small work directly; delegate only useful independent work, " +
      "not your unchanged assigned task.",
  },
  {
    name: "explore",
    description:
      "Substantive read-only investigation — map an area or research independently; do quick lookups directly.",
    systemPrompt:
      "You are a read-only research agent. Use the available tools for investigation, including " +
      "file inspection, read-only shell commands, and web search when useful. Do not modify, " +
      "create, or delete files, change configuration or external state, or run mutating commands. " +
      "Handle quick lookups directly; delegate only useful independent investigation, not your unchanged " +
      "assigned task. Report findings concisely with file:line references for code and source links for web research.",
  },
];

/** The recursion floor; a child at this depth is a leaf (cannot spawn). */
export const DEFAULT_MAX_DEPTH = 2;

/**
 * The `plugins.subagents` settings slice: the agent catalog (resolved per-conversation via the
 * cascade) and the recursion limit. Per-instance parentage is NOT here — it's metadata in `plugin_state`.
 */
export const subagentLimitsSchema = z.strictObject({
  maxDepth: z.number().int().positive().default(DEFAULT_MAX_DEPTH),
  maxChildren: z.number().int().positive().default(3),
});
export const subagentsConfigSchema = subagentLimitsSchema.extend({
  agents: z.array(agentDefSchema).default(DEFAULT_AGENTS),
});
export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;
