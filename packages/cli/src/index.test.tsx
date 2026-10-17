import { BUILTIN_APPROVAL_DEFAULTS } from "@harness/server";
import { launch } from "./index.tsx";
import type { CliService } from "./client-harness.ts";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation, ConversationId } from "@harness/protocol";
import { ActivityManager, type Activity, type ActivityResult } from "@harness/activities";
import { launchOverrides, loadSession, Root, type Session } from "./session-app.tsx";
import { testPlugins } from "./test-plugins.ts";
import type { CliPlugins } from "./client-plugins.ts";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const conversation = {
  id: "c1" as ConversationId,
  workspaceRoot: "/work",
  config: { instructions: "", model: { provider: "demo", model: "demo-1" } },
  overrides: {},
  head: null,
  createdAt: 0,
} as Conversation;

function rootHarness(manager?: ActivityManager): {
  service: CliService;
  deactivate: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  plugins: CliPlugins;
  order: string[];
} {
  const order: string[] = [];
  const subscribe = vi.fn(() => () => {});
  const deactivate = vi.fn(async () => {
    order.push("deactivate");
    return { status: "deactivated" as const };
  });
  const service = {
    subscribe,
    availableModels: () => [],
    service: (_id: ConversationId, key: string) => (key === "activities" ? manager : undefined),
    deactivateSession: deactivate,
    attachedConversation: async () => {
      order.push("prepare");
      return conversation;
    },
    getItems: async () => {
      order.push("getItems");
      return [];
    },
    usageSummary: async () => {
      order.push("usageSummary");
      return {
        usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
        incomplete: false,
        cost: 0,
      };
    },
    prepare: async () => {
      order.push("prepare");
    },
    setPluginConfig: async () => {
      order.push("mutation");
    },
  } as unknown as CliService;
  const plugins = testPlugins({
    runningActivities: () => manager?.runningCount() ?? 0,
  });
  return { service, deactivate, subscribe, plugins, order };
}

const start: { kind: "session"; session: Session } = {
  kind: "session",
  session: {
    conversation,
    items: [],
    usage: {
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
      incomplete: false,
      cost: 0,
    },
  },
};

describe("CLI approval defaults", () => {
  it("allows activity and subagent controls plus worktree listing", () => {
    expect(BUILTIN_APPROVAL_DEFAULTS).toEqual({
      activity_wait: "allow",
      activity_peek: "allow",
      activity_list: "allow",
      activity_kill: "allow",
      subagent: "allow",
      subagent_list: "allow",
      subagent_send: "allow",
      subagent_dismiss: "allow",
      worktree_list: "allow",
    });
  });
});

describe("launchOverrides", () => {
  it("does not carry the fallback model's preset into --model", () => {
    expect(
      launchOverrides({ provider: "openai", model: "old", preset: "high" }, "new"),
    ).toMatchObject({ model: { provider: "openai", model: "new" } });
    expect(
      launchOverrides({ provider: "openai", model: "old", preset: "high" }, "new").model,
    ).not.toHaveProperty("preset");
  });
});

describe("isolated launch", () => {
  it("rejects host flags before starting an isolated Local server", async () => {
    await expect(launch({ connectStdio: true, host: "remote" })).rejects.toThrow(
      "Choose --connect-stdio",
    );
    await expect(launch({ connectStdio: true, ssh: "workstation" })).rejects.toThrow(
      "Choose --connect-stdio",
    );
  });
});

describe("loadSession", () => {
  it("prepares the selected conversation before mounting its session", async () => {
    const conversation = {
      id: "c1" as ConversationId,
      workspaceRoot: "/work",
      config: { instructions: "", model: { provider: "demo", model: "demo-1" } },
      overrides: {},
      head: null,
      createdAt: 0,
    } as Conversation;
    const attachedConversation = vi.fn().mockResolvedValue(conversation);
    const service = {
      attachedConversation,
      getItems: vi.fn().mockResolvedValue([]),
      usageSummary: vi.fn().mockResolvedValue({
        usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
        incomplete: false,
        cost: 0,
      }),
    } as unknown as CliService;

    await expect(loadSession(service, "c1")).resolves.toEqual({
      conversation,
      items: [],
      usage: {
        usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
        incomplete: false,
        cost: 0,
      },
    });
    expect(attachedConversation).toHaveBeenCalledWith(conversation.id);
  });
});

describe("Root session lifecycle", () => {
  it("deactivates before preparing a same-id reload", async () => {
    const { service, plugins, order, subscribe } = rootHarness();
    const { stdin, lastFrame } = render(
      <Root service={service} plugins={plugins} start={start} cwd="/work" onActive={() => {}} />,
    );
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    stdin.write("/reload");
    await flush();
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("conversation reloaded"));

    expect(order[0]).toBe("deactivate");
    expect(order.indexOf("prepare")).toBeGreaterThan(order.indexOf("deactivate"));
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("applies a sandbox change while attached before replacing the runtime", async () => {
    const { service, plugins, order, deactivate } = rootHarness();
    const { stdin, lastFrame } = render(
      <Root service={service} plugins={plugins} start={start} cwd="/work" onActive={() => {}} />,
    );

    stdin.write("/sandbox native");
    await flush();
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox backend → native"));

    expect(order.indexOf("mutation")).toBeLessThan(order.indexOf("deactivate"));
    expect(order.indexOf("prepare")).toBeGreaterThan(order.indexOf("deactivate"));
    expect(deactivate).toHaveBeenCalledWith(conversation.id, { force: true });
  });

  it("confirms background cleanup and serializes repeated confirmation", async () => {
    let settle!: () => void;
    const done = new Promise<ActivityResult>(
      (resolve) => (settle = () => resolve({ status: "error", summary: "stopped", view: [] })),
    );
    const manager = new ActivityManager(conversation.id);
    manager.track(
      {
        id: "background",
        kind: "test",
        title: "background",
        peek: () => [],
        kill: settle,
        done,
      } satisfies Activity,
      { callId: "background", emit: () => {} },
    );
    const { service, plugins, deactivate } = rootHarness(manager);
    const { stdin, lastFrame } = render(
      <Root service={service} plugins={plugins} start={start} cwd="/work" onActive={() => {}} />,
    );

    stdin.write("/reload");
    await flush();
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("stop 1 running activity and reload?"));
    expect(deactivate).not.toHaveBeenCalled();

    stdin.write("n");
    await vi.waitFor(() => expect(lastFrame()).not.toContain("stop 1 running activity"));
    expect(deactivate).not.toHaveBeenCalled();

    stdin.write("/reload");
    await flush();
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("stop 1 running activity and reload?"));
    stdin.write("y");
    stdin.write("y");
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledOnce());
    expect(deactivate).toHaveBeenCalledWith(conversation.id, { force: true });
    settle();
  });
});
