import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation, HarnessEvent } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { App } from "./app.tsx";

const conversation = {
  id: "c1",
  config: { instructions: "", model: { provider: "demo", model: "demo-1" } },
  head: null,
  createdAt: 0,
} as unknown as Conversation;

function harness(): { service: HarnessService; emit: (e: HarnessEvent) => void } {
  let listener: ((e: HarnessEvent) => void) | undefined;
  const service = {
    subscribe: (l: (e: HarnessEvent) => void) => {
      listener = l;
      return () => (listener = undefined);
    },
    deliver: vi.fn(async () => {}),
    respond: vi.fn(),
  } as unknown as HarnessService;
  return { service, emit: (e) => listener?.(e) };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const mount = (service: HarnessService) =>
  render(
    <App
      service={service}
      conversation={conversation}
      initialItems={[]}
      cwd="/tmp"
      onResume={() => {}}
    />,
  );

describe("App", () => {
  it("shows the composer and the model on mount", () => {
    const { service } = harness();
    const { lastFrame } = mount(service);
    expect(lastFrame()).toContain("type a message");
    expect(lastFrame()).toContain("demo-1");
  });

  it("updates the displayed model when a config.changed event arrives", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    expect(lastFrame()).toContain("demo-1");
    emit({
      type: "config.changed",
      conversationId: "c1",
      model: { provider: "openai", model: "gpt-5.1" },
    });
    await flush();
    expect(lastFrame()).toContain("gpt-5.1");
  });

  it("renders streaming assistant text from the event stream", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", turnId: "t1", status: "running" });
    emit({ type: "text_delta", turnId: "t1", text: "Hello there" });
    await flush();
    expect(lastFrame()).toContain("Hello there");
  });

  it("shows an approval prompt and hides the composer while pending", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", turnId: "t1", status: "running" });
    emit({
      type: "request.created",
      requestId: "q1",
      conversationId: "c1",
      request: { kind: "approval", call: { name: "bash" } },
    });
    await flush();
    expect(lastFrame()).toContain("approve bash?");
    expect(lastFrame()).not.toContain("type a message");
  });
});
