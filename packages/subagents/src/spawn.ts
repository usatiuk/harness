import type { ConversationId, ConversationOverrides, ConversationRunner } from "@harness/protocol";
import { identity } from "./family.ts";
import type { SpawnMark } from "./registry.ts";

interface SpawnInit {
  runner: ConversationRunner;
  parent: ConversationId;
  callId: string;
  agentName: string;
  name: string;
  slug: string;
  task: string;
  signal?: AbortSignal;
  cwd?: string;
  overrides: ConversationOverrides;
}

export async function spawnSubagent(init: SpawnInit) {
  const parent = await identity(init.runner, init.parent);
  init.signal?.throwIfAborted();
  const child = await init.runner.createConversation(
    init.cwd !== undefined
      ? { cwd: init.cwd, overrides: init.overrides, parentId: init.parent }
      : { overrides: init.overrides, parentId: init.parent },
  );
  await init.runner.putPluginState(
    "subagents",
    child.id,
    "spawn",
    {
      parent: { conversationId: init.parent, callId: init.callId },
      agent: init.agentName,
      name: init.name,
      slug: init.slug,
    } satisfies SpawnMark,
    init.parent,
  );
  await init.runner.putPluginState("subagents", init.parent, `slug:${init.slug}`, child.id);
  try {
    await init.runner.deliver(
      child.id,
      `You are subagent ${init.name} [${init.slug}], using the ${init.agentName} profile.\n` +
        `Your direct parent is ${parent.name}${parent.slug !== parent.id ? ` [${parent.slug}]` : ""} (parent).\n` +
        `Assigned task:\n${init.task}`,
      "send",
      init.signal,
    );
  } catch (cause) {
    throw new Error(
      `Created ${init.name} [${init.slug}] (${child.id}), but its initial task was not accepted: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return { childId: child.id };
}
