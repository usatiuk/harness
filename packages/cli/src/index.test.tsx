import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation, ConversationId } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { ActivityManager, type Activity, type ActivityResult } from "@harness/activities";
import { ACTIVITY_APPROVAL_DEFAULTS, loadSession, Root, type Session } from "./index.tsx";

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
  service: HarnessService;
  deactivate: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
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
    getConversation: async () => {
      order.push("getConversation");
      return conversation;
    },
    getItems: async () => {
      order.push("getItems");
      return [];
    },
    usage: async () => {
      order.push("usage");
      return [];
    },
    prepare: async () => {
      order.push("prepare");
    },
    setPluginConfig: async () => {
      order.push("mutation");
    },
  } as unknown as HarnessService;
  return { service, deactivate, subscribe, order };
}

const start: { kind: "session"; session: Session } = {
  kind: "session",
  session: { conversation, items: [], usage: [] },
};

describe("CLI approval defaults", () => {
  it("allows controls for activities already owned by the conversation", () => {
    expect(ACTIVITY_APPROVAL_DEFAULTS).toEqual({
      activity_wait: "allow",
      activity_peek: "allow",
      activity_list: "allow",
      activity_kill: "allow",
    });
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
    const prepare = vi.fn().mockResolvedValue(undefined);
    const service = {
      getConversation: vi.fn().mockResolvedValue(conversation),
      getItems: vi.fn().mockResolvedValue([]),
      usage: vi.fn().mockResolvedValue([]),
      prepare,
    } as unknown as HarnessService;

    await expect(loadSession(service, "c1")).resolves.toEqual({
      conversation,
      items: [],
      usage: [],
    });
    expect(prepare).toHaveBeenCalledWith(conversation.id);
  });
});

describe("Root session lifecycle", () => {
  it("deactivates before preparing a same-id reload", async () => {
    const { service, order, subscribe } = rootHarness();
    const { stdin, lastFrame } = render(
      <Root service={service} start={start} cwd="/work" onActive={() => {}} />,
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

  it("applies a sandbox change between deactivation and reactivation", async () => {
    const { service, order } = rootHarness();
    const { stdin, lastFrame } = render(
      <Root service={service} start={start} cwd="/work" onActive={() => {}} />,
    );

    stdin.write("/sandbox native");
    await flush();
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox backend → native"));

    expect(order.indexOf("mutation")).toBeGreaterThan(order.indexOf("deactivate"));
    expect(order.indexOf("prepare")).toBeGreaterThan(order.indexOf("mutation"));
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
    const { service, deactivate } = rootHarness(manager);
    const { stdin, lastFrame } = render(
      <Root service={service} start={start} cwd="/work" onActive={() => {}} />,
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
    settle();
  });
});
