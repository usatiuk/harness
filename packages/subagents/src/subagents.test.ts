import { describe, expect, it } from "vitest";
import { ActivityManager, consume } from "@harness/activities";
import type {
  Conversation,
  ConversationId,
  ConversationOverrides,
  ConversationRunner,
  HarnessEvent,
  Item,
  ItemId,
  ModelConfig,
  ModelMiddlewareContext,
  ModelRequest,
  ToolMiddlewareContext,
  ToolSchema,
  TurnId,
} from "@harness/protocol";
import { textOf } from "@harness/protocol";
import {
  SubagentRegistry,
  SubagentTool,
  depthOf,
  subagentContractResolver,
  subagentsConfigSchema,
} from "./index.ts";

const id = (s: string): ConversationId => s as ConversationId;
const MODEL: ModelConfig = { provider: "fake", model: "fake-1" };

/** A minimal record view for the fake's `getConversation` (only `workspaceRoot` is read). */
const record = (cid: ConversationId, overrides: ConversationOverrides): Conversation => ({
  id: cid,
  workspaceRoot: null,
  overrides,
  head: null,
  createdAt: 0,
  config: { instructions: "", model: MODEL },
});

interface FakeRunner extends ConversationRunner {
  /** Created child conversations, in creation order (last is the most recent spawn). */
  created: Conversation[];
  /** Settle a child's turn: emit an assistant message + completed (mirrors the real async turn end). */
  release(cid: ConversationId, response: string): void;
}

/**
 * A stand-in for HarnessService over child conversations: mints ids, stores `plugin_state` and
 * overrides, and accepts a `send` without waiting (the real `deliver` returns once input is
 * accepted, not once the turn completes). The turn is settled on demand via `release`; an
 * `interrupt` settles it as aborted. Deterministic — no real engine needed.
 */
function fakeRunner(): FakeRunner {
  const created: Conversation[] = [];
  const listeners = new Map<ConversationId, Set<(e: HarnessEvent) => void>>();
  const state = new Map<string, unknown>();
  // A child's turn is "running" once `send` is accepted, until it settles (release=completed,
  // interrupt=aborted) — mirroring the real engine, where `deliver` returns before the turn's
  // settling write. `whenIdle` resolves only on settle, so a caller that skips it races the write.
  const running = new Set<ConversationId>();
  const idleWaiters = new Map<ConversationId, Set<() => void>>();
  const settle = (cid: ConversationId): void => {
    running.delete(cid);
    const waiters = idleWaiters.get(cid);
    if (waiters) {
      idleWaiters.delete(cid);
      for (const resolve of waiters) resolve();
    }
  };
  let n = 0;
  let itemSeq = 0;
  const emit = (cid: ConversationId, event: HarnessEvent): void => {
    for (const l of listeners.get(cid) ?? []) l(event);
  };
  const msg = (cid: ConversationId, text: string): Item => ({
    id: `i${++itemSeq}` as ItemId,
    conversationId: cid,
    turnId: "t" as TurnId,
    seq: itemSeq,
    parent: null,
    createdAt: 0,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
  });
  return {
    created,
    release(cid, response) {
      emit(cid, { type: "item.appended", conversationId: cid, item: msg(cid, response) });
      emit(cid, {
        type: "turn.status",
        conversationId: cid,
        turnId: "t" as TurnId,
        status: "completed",
      });
      settle(cid);
    },
    async createConversation(opts) {
      const child = record(id(`child${++n}`), opts.overrides ?? {});
      created.push(child);
      return child;
    },
    async deliver(cid, text, intent) {
      if (intent === "interrupt") {
        emit(cid, {
          type: "turn.status",
          conversationId: cid,
          turnId: "t" as TurnId,
          status: "aborted",
        });
        settle(cid); // interrupt ends the running turn
      } else if (intent === "send" && text) {
        running.add(cid); // input accepted; the turn is running until it settles
      }
    },
    subscribe(cid, listener) {
      const existing = listeners.get(cid);
      const set = existing ?? new Set();
      if (!existing) listeners.set(cid, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    whenIdle(cid) {
      if (!running.has(cid)) return Promise.resolve();
      return new Promise((resolve) => {
        let waiters = idleWaiters.get(cid);
        if (!waiters) {
          waiters = new Set();
          idleWaiters.set(cid, waiters);
        }
        waiters.add(resolve);
      });
    },
    getItems: () => Promise.resolve([]),
    getConversation: (cid) => Promise.resolve(created.find((c) => c.id === cid)),
    putPluginState: (plugin, cid, key, value) => {
      state.set(`${plugin}|${cid}|${key}`, value);
      return Promise.resolve();
    },
    getPluginState: (plugin, cid, key) => Promise.resolve(state.get(`${plugin}|${cid}|${key}`)),
  };
}

/** A fake ConfigReader returning a fixed catalog slice for any conversation. */
const fakeReader = (cfg: unknown): { get: () => Promise<unknown> } => ({
  get: () => Promise.resolve(cfg),
});

/** A ToolMiddlewareContext wired to an ActivityManager, mirroring the activities test fixture. */
function ctx(
  mgr: ActivityManager,
  conversationId: ConversationId,
  callId = "call_1",
): ToolMiddlewareContext {
  return {
    conversationId,
    callId,
    signal: new AbortController().signal,
    service: (k) => (k === "activities" ? mgr : undefined),
    emit: () => {},
    deliver: () => {},
    toolMeta: () => undefined,
    toolContract: () => undefined,
    acceptsToolCall: () => true,
    setResultAnnotation: () => {},
    putBlob: () => Promise.resolve({ id: "b", bytes: 0, contentType: "text/plain" }),
    request: () => Promise.resolve({}),
    active: () => Promise.resolve([]),
    appendContext: () => Promise.resolve(),
  };
}

const AGENT = {
  name: "researcher",
  description: "looks things up",
  systemPrompt: "you are a researcher",
  tools: { allow: ["read", "subagent"] },
};

describe("SubagentTool — spawn", () => {
  it("delegates, returns the child's final output, stamps parentage, and registers live", async () => {
    const runner = fakeRunner();
    const registry = new SubagentRegistry();
    const mgr = new ActivityManager(id("parent"));
    const tool = new SubagentTool({
      reader: fakeReader({ agents: [AGENT], maxDepth: 3 }) as never,
      runner: () => runner,
      registry,
    });

    const placeholder = await tool.execute(
      { agent: "researcher", task: "find x" },
      ctx(mgr, id("parent")),
    );
    expect(placeholder.status).toBe("ok");

    const child = runner.created[0]!;
    // Durable parentage stamped in plugin_state — NOT in settings/overrides (settings vs metadata).
    expect(child.overrides).not.toHaveProperty("plugins");
    expect(await runner.getPluginState("subagents", child.id, "spawn")).toEqual({
      parent: { conversationId: id("parent"), callId: "call_1" },
      agent: "researcher",
    });
    // While the child is live, the registry tracks it for cascade-stop.
    expect(registry.descendantsOf(id("parent"))).toEqual([child.id]);

    runner.release(child.id, "CHILD:find x");
    // The settled child stays tracked (interrupting an idle conversation is a no-op) so
    // cascade-stop never misses a descendant.
    const activity = mgr.claim("call_1")!;
    const result = await consume(mgr, activity, false, ctx(mgr, id("parent")));
    expect(result.status).toBe("ok");
    expect(textOf(result.forModel)).toContain("CHILD:find x");
    expect(registry.descendantsOf(id("parent"))).toEqual([child.id]);
  });

  it("errors on an unknown agent and spawns nothing", async () => {
    const runner = fakeRunner();
    const tool = new SubagentTool({
      reader: fakeReader({ agents: [AGENT], maxDepth: 3 }) as never,
      runner: () => runner,
      registry: new SubagentRegistry(),
    });
    const result = await tool.execute(
      { agent: "ghost", task: "x" },
      ctx(new ActivityManager(id("parent")), id("parent")),
    );
    expect(result.status).toBe("error");
    expect(textOf(result.forModel)).toContain("unknown agent: ghost");
    expect(runner.created).toHaveLength(0);
  });
});

describe("SubagentTool — depth", () => {
  it("refuses to spawn when the parent is already at maxDepth", async () => {
    const runner = fakeRunner();
    // Seed parentage so the dispatching conversation is itself a depth-1 child (maxDepth 1 ⇒ leaf).
    await runner.putPluginState("subagents", id("parent"), "spawn", {
      parent: { conversationId: id("grandparent"), callId: "x" },
      agent: "researcher",
    });
    const tool = new SubagentTool({
      reader: fakeReader({ agents: [AGENT], maxDepth: 1 }) as never,
      runner: () => runner,
      registry: new SubagentRegistry(),
    });
    const result = await tool.execute(
      { agent: "researcher", task: "x" },
      ctx(new ActivityManager(id("parent")), id("parent")),
    );
    expect(result.status).toBe("error");
    expect(textOf(result.forModel)).toContain("depth limit");
    expect(runner.created).toHaveLength(0);
  });

  it("keeps the agent's full scope at any depth (recursion is bounded by the spawn check, not scope stripping)", async () => {
    const runner = fakeRunner();
    // depthOf(parent) = 1; with maxDepth 2 the child sits at depth 2 — still allowed to spawn, and
    // still carries its full scope. The NEXT spawn (parentDepth 2 ≥ 2) is what gets refused.
    await runner.putPluginState("subagents", id("parent"), "spawn", {
      parent: { conversationId: id("grandparent"), callId: "x" },
      agent: "researcher",
    });
    const tool = new SubagentTool({
      reader: fakeReader({ agents: [AGENT], maxDepth: 2 }) as never,
      runner: () => runner,
      registry: new SubagentRegistry(),
    });
    await tool.execute(
      { agent: "researcher", task: "x" },
      ctx(new ActivityManager(id("parent")), id("parent")),
    );
    expect(runner.created[0]!.overrides.tools).toEqual({ allow: ["read", "subagent"] });
  });

  it("a child whose agent omits `subagent` cannot delegate", async () => {
    const runner = fakeRunner();
    const leaf = { ...AGENT, tools: { allow: ["read"] } };
    const tool = new SubagentTool({
      reader: fakeReader({ agents: [leaf], maxDepth: 3 }) as never,
      runner: () => runner,
      registry: new SubagentRegistry(),
    });
    await tool.execute(
      { agent: "researcher", task: "x" },
      ctx(new ActivityManager(id("parent")), id("parent")),
    );
    expect(runner.created[0]!.overrides.tools).toEqual({ allow: ["read"] });
  });
});

describe("depthOf", () => {
  it("walks the durable plugin_state parent links", async () => {
    const runner = fakeRunner();
    await runner.putPluginState("subagents", id("c"), "spawn", {
      parent: { conversationId: id("b"), callId: "x" },
      agent: "a",
    });
    await runner.putPluginState("subagents", id("b"), "spawn", {
      parent: { conversationId: id("a"), callId: "x" },
      agent: "a",
    });
    expect(await depthOf(runner, id("c"), 5)).toBe(2);
    expect(await depthOf(runner, id("a"), 5)).toBe(0); // top-level: no spawn mark
  });
});

describe("subagentsConfigSchema — built-in agents", () => {
  it("ships general + explore when `agents` is unset, and replacing it drops the built-ins", () => {
    // Unset ⇒ the built-in defaults (general unrestricted, explore read-only).
    const defaults = subagentsConfigSchema.parse({});
    expect(defaults.agents.map((a) => a.name)).toEqual(["general", "explore"]);
    const explore = defaults.agents.find((a) => a.name === "explore")!;
    expect(explore.tools).toEqual({
      allow: ["read_file", "glob", "bash", "powershell"],
    });
    expect(defaults.agents.find((a) => a.name === "general")!.tools).toBeUndefined();

    // Setting `agents` replaces wholesale (no merge) — the built-ins are gone unless redeclared.
    const replaced = subagentsConfigSchema.parse({
      agents: [{ name: "researcher", description: "r", systemPrompt: "r" }],
    });
    expect(replaced.agents.map((a) => a.name)).toEqual(["researcher"]);
  });

  it("rejects a malformed agent definition", () => {
    expect(() => subagentsConfigSchema.parse({ agents: [{ name: "x" }] })).toThrow(); // missing description + systemPrompt
  });
});

describe("subagentContractResolver", () => {
  const baseTool = {
    kind: "function" as const,
    name: "subagent",
    description: "base",
    parameters: {
      type: "object",
      properties: { agent: { type: "string" }, task: { type: "string" } },
    },
  };
  const mwCtx = (): ModelMiddlewareContext => ({
    conversationId: id("c"),
    signal: new AbortController().signal,
    toolMeta: () => undefined,
  });
  /** Drains the middleware into the request the next handler actually saw. */
  const applied = async (
    mw: ReturnType<typeof subagentContractResolver>,
    tools: ToolSchema[],
  ): Promise<ModelRequest | undefined> => {
    const request: ModelRequest = {
      instructions: [],
      items: [],
      modelConfig: { provider: "x", model: "y" },
      tools,
    };
    const contracts = await Promise.all(tools.map(async (input) => await mw({ input }, mwCtx())));
    return {
      ...request,
      tools: contracts.flatMap((contract) => (contract ? [contract.input] : [])),
    };
  };

  it("constrains `agent` to the catalog names and lists the roster in the description", async () => {
    const mw = subagentContractResolver(
      fakeReader({
        agents: [
          { name: "researcher", description: "finds things", systemPrompt: "s" },
          { name: "coder", description: "writes code", systemPrompt: "s" },
        ],
      }) as never,
    );
    const seen = await applied(mw, [baseTool]);
    const tool = seen!.tools![0] as unknown as {
      parameters: { properties: { agent: { enum?: string[] } } };
      description: string;
    };
    expect(tool.parameters.properties.agent.enum).toEqual(["researcher", "coder"]);
    expect(tool.description).toContain("researcher");
    expect(tool.description).toContain("coder");
  });

  it("drops the tool when no agents are configured", async () => {
    const mw = subagentContractResolver(fakeReader({ agents: [] }) as never);
    const seen = await applied(mw, [baseTool]);
    expect(seen!.tools).toHaveLength(0);
  });

  it("leaves the request untouched when the subagent tool isn't offered", async () => {
    const mw = subagentContractResolver(
      fakeReader({ agents: [{ name: "a", description: "d", systemPrompt: "s" }] }) as never,
    );
    const other = {
      kind: "function" as const,
      name: "read",
      description: "r",
      parameters: { type: "object", properties: {} },
    };
    const seen = await applied(mw, [other]);
    expect(seen!.tools).toEqual([other]);
  });

  it("preserves a `background` arg injected by another middleware", async () => {
    const withBackground = {
      ...baseTool,
      parameters: {
        ...baseTool.parameters,
        properties: { ...baseTool.parameters.properties, background: { type: "boolean" } },
      },
    };
    const mw = subagentContractResolver(
      fakeReader({ agents: [{ name: "a", description: "d", systemPrompt: "s" }] }) as never,
    );
    const seen = await applied(mw, [withBackground]);
    const props = (
      seen!.tools![0] as unknown as { parameters: { properties: Record<string, unknown> } }
    ).parameters.properties;
    expect(props.agent).toBeDefined();
    expect(props.background).toBeDefined(); // not clobbered by the roster rewrite
  });
});
