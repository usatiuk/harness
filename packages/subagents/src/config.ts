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
      "Investigate independently; can leave a research note or take on an explicit follow-up from its parent.",
    systemPrompt:
      "Investigate without changing project or external state by default. When findings are worth keeping, " +
      "write a research note in the writable temporary directory or a directory designated by your parent, " +
      "and return its path with a concise summary. Your parent may explicitly reassign you from research " +
      "to implementation or another role. For that assignment you may create, edit or delete files, run " +
      "commands, and make other requested changes within its scope. Tool, sandbox and approval rules " +
      "still apply. Handle quick " +
      "lookups directly; cite file:line references for code and source links for web research.",
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
