import { z } from "zod";
import type {
  ConfigReader,
  ConversationId,
  ConversationOverrides,
  ConversationRunner,
} from "@harness/protocol";
import type { SubagentsConfig } from "./config.ts";
import { identity, isDismissed, rosterPage, spawnMark } from "./family.ts";

/** Count durable spawn ancestors, walking only as far as the configured limit. */
export async function depthOf(runner: ConversationRunner, id: ConversationId, bound: number) {
  let depth = 0;
  while (depth < bound) {
    const mark = await spawnMark(runner, id);
    if (!mark) break;
    depth++;
    id = mark.parent.conversationId as ConversationId;
  }
  return depth;
}

export const subagentArgs = z.strictObject({
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
  task: z.string().describe("The task for the subagent: its full prompt for this delegation."),
});

export type SpawnRequest = z.infer<typeof subagentArgs> & {
  parent: ConversationId;
  callId?: string;
  signal?: AbortSignal;
};

/** Normal admission refusals are model-facing errors, unlike a broken store or failed delivery. */
export class SpawnRejected extends Error {}

/** Cancel only the wait; the queue position still depends on its predecessor. */
async function waitForAdmission(previous: Promise<void>, signal?: AbortSignal) {
  if (!signal) return previous;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** One admissions owner per service; independent parents need not wait on one another. */
export function createSpawnOperation(reader: ConfigReader, getRunner: () => ConversationRunner) {
  const pending = new Map<ConversationId, Promise<void>>();
  return async ({ parent, callId, signal, ...input }: SpawnRequest) => {
    const args = subagentArgs.safeParse(input);
    if (!args.success) throw new SpawnRejected(args.error.issues[0]!.message);
    const { agent, name, slug, task } = args.data;
    signal?.throwIfAborted();
    const runner = getRunner();
    const previous = pending.get(parent) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => slot);
    pending.set(parent, tail);
    void tail.then(() => {
      if (pending.get(parent) === tail) pending.delete(parent);
    });
    let childId: ConversationId;
    let parentIdentity: Awaited<ReturnType<typeof identity>>;
    try {
      await waitForAdmission(previous, signal);
      signal?.throwIfAborted();
      const cfg = await reader.get<SubagentsConfig>("subagents", parent);
      const profile = cfg.agents.find((entry) => entry.name === agent);
      if (!profile)
        throw new SpawnRejected(
          `unknown agent: ${agent}. Available: ${cfg.agents.map((entry) => entry.name).join(", ") || "(none configured)"}`,
        );
      const owner = await runner.getConversation(parent);
      if (!owner) throw new Error(`Unknown conversation: ${parent}`);
      if (owner.closed || (await isDismissed(runner, parent)))
        throw new SpawnRejected("Closed or dismissed subagents cannot spawn children.");
      if (owner.config.tools?.allow && !owner.config.tools.allow.includes("subagent"))
        throw new SpawnRejected("Subagent spawning is not allowed in this conversation.");
      if ((await depthOf(runner, parent, cfg.maxDepth)) >= cfg.maxDepth)
        throw new SpawnRejected(`subagent depth limit reached (max ${cfg.maxDepth})`);
      if ((await rosterPage(runner, parent, cfg.maxChildren)).length >= cfg.maxChildren)
        throw new SpawnRejected(
          `Subagent limit reached (${cfg.maxChildren} active children). Dismiss a child before spawning another.`,
        );
      if ((await runner.getPluginState("subagents", parent, `slug:${slug}`)) !== undefined)
        throw new SpawnRejected(`subagent slug already exists: ${slug}`);
      parentIdentity = await identity(runner, parent);
      const overrides: ConversationOverrides = { instructions: profile.systemPrompt };
      if (profile.model) overrides.model = profile.model;
      if (profile.tools?.allow) overrides.tools = { allow: profile.tools.allow };
      signal?.throwIfAborted();
      const child = await runner.createConversation({
        parentId: parent,
        childState: {
          plugin: "subagents",
          key: "spawn",
          parentIndexKey: `slug:${slug}`,
          value: {
            parent: { conversationId: parent, ...(callId !== undefined && { callId }) },
            agent,
            name,
            slug,
          } satisfies NonNullable<Awaited<ReturnType<typeof spawnMark>>>,
        },
        overrides,
        ...(owner.workspaceRoot !== null ? { cwd: owner.workspaceRoot } : {}),
      });
      childId = child.id;
    } finally {
      release();
    }
    try {
      await runner.deliver(
        childId,
        `You are subagent ${name} [${slug}], using the ${agent} profile.\n` +
          `Your direct parent is ${parentIdentity.name}${parentIdentity.slug !== parentIdentity.id ? ` [${parentIdentity.slug}]` : ""} (parent).\n` +
          `Assigned task:\n${task}`,
        "send",
        signal,
      );
    } catch (cause) {
      throw new Error(
        `Created ${name} [${slug}] (${childId}), but its initial task was not accepted: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    return { childId, name, slug };
  };
}
