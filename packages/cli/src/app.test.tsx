import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation, HarnessEvent, Item } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { LocalExecutionContext } from "@harness/execution";
import { DockerExecutionContext, NativeExecutionContext } from "@harness/sandbox";
import { App, appReduce, sandboxBackendOf } from "./app.tsx";
import { emptyState, type Cell } from "./transcript-reducer.ts";

const shellCells = (cells: Cell[]): Extract<Cell, { kind: "shell" }>[] =>
  cells.filter((c): c is Extract<Cell, { kind: "shell" }> => c.kind === "shell");

const conversation = {
  id: "c1",
  config: { instructions: "", model: { provider: "demo", model: "demo-1" } },
  head: null,
  createdAt: 0,
} as unknown as Conversation;

function harness(): { service: HarnessService; emit: (e: HarnessEvent) => void } {
  let listener: ((e: HarnessEvent) => void) | undefined;
  const service = {
    // Mirrors the scoped overload the App uses: subscribe(conversationId, listener).
    subscribe: (_conversationId: unknown, l: (e: HarnessEvent) => void) => {
      listener = l;
      return () => (listener = undefined);
    },
    deliver: vi.fn(async () => {}),
    respond: vi.fn(),
    availableModels: () => [],
    service: () => undefined,
  } as unknown as HarnessService;
  return { service, emit: (e) => listener?.(e) };
}

// React commits emitted updates asynchronously (scheduler ticks), so frame assertions
// after an emit poll with vi.waitFor instead of racing the commit with a timer.
const mount = (service: HarnessService, initialItems: Item[] = []) =>
  render(
    <App
      service={service}
      conversation={conversation}
      initialItems={initialItems}
      initialUsage={[]}
      cwd="/tmp"
      launchCwd="/tmp"
      onResume={() => {}}
      activities={{ peek: () => [], kill: () => {} }}
    />,
  );

describe("App", () => {
  it("identifies the backend from the actual cached execution instance", () => {
    expect(sandboxBackendOf(new LocalExecutionContext("/work"))).toBe("local");
    expect(sandboxBackendOf(Object.create(NativeExecutionContext.prototype))).toBe("native");
    expect(sandboxBackendOf(Object.create(DockerExecutionContext.prototype))).toBe("docker");
    expect(sandboxBackendOf(undefined)).toBeUndefined();
  });

  it("shows the composer and the model on mount", () => {
    const { service } = harness();
    const { lastFrame } = mount(service);
    expect(lastFrame()).toContain("type a message");
    expect(lastFrame()).toContain("demo-1");
  });

  it("separates semantic transcript blocks and collapses resumed routine work", () => {
    const { service } = harness();
    const base = {
      conversationId: "c1",
      turnId: "t1",
      parent: null,
    };
    const items = [
      {
        ...base,
        type: "message",
        role: "user",
        id: "u1",
        seq: 0,
        createdAt: 0,
        content: [{ type: "text", text: "inspect" }],
      },
      {
        ...base,
        type: "reasoning",
        id: "r1",
        seq: 1,
        createdAt: 1_000,
        content: [{ type: "text", text: "private reasoning" }],
      },
      {
        ...base,
        type: "tool_call",
        id: "tc1",
        seq: 2,
        createdAt: 2_000,
        callId: "read-1",
        name: "read_file",
        args: { path: "README.md" },
      },
      {
        ...base,
        type: "tool_result",
        id: "tr1",
        seq: 3,
        createdAt: 3_000,
        callId: "read-1",
        status: "ok",
        content: [{ type: "text", text: "# Harness" }],
      },
      {
        ...base,
        type: "message",
        role: "assistant",
        id: "a1",
        seq: 4,
        createdAt: 4_000,
        content: [{ type: "text", text: "done" }],
      },
    ] as Item[];
    const { lastFrame } = mount(service, items);
    expect(lastFrame()).toContain("› inspect\n\n• Worked for 3s · read 1 file\n\n  done");
    expect(lastFrame()).not.toContain("private reasoning");
    expect(lastFrame()).not.toContain("# Harness");
  });

  it("updates the displayed model when a config.changed event arrives", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    expect(lastFrame()).toContain("demo-1");
    emit({
      type: "config.changed",
      conversationId: "c1",
      config: {
        instructions: "",
        model: { provider: "openai", model: "gpt-5.1" },
        plugins: {},
      },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("gpt-5.1"));
  });

  it("renders streaming assistant text from the event stream", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({ type: "text_delta", conversationId: "c1", turnId: "t1", text: "Hello there" });
    await vi.waitFor(() => expect(lastFrame()).toContain("Hello there"));
  });

  it("collapses a running tool's args by default and expands them on Ctrl+O", async () => {
    const { service, emit } = harness();
    const { stdin, lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "k1",
      name: "bash",
      args: { command: "npm test" },
    });
    // Compact: the command is shown as a summary, the raw args JSON is not.
    await vi.waitFor(() => expect(lastFrame()).toContain("npm test"));
    expect(lastFrame()).not.toContain('"command"');
    stdin.write("\x0f"); // Ctrl+O toggles verbose
    // Verbose: the full args blob renders for the still-live cell.
    await vi.waitFor(() => expect(lastFrame()).toContain('"command"'));
  });

  it("renders live auto-review progress and the final saved decision", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "k1",
      name: "bash",
      args: { command: "echo hi" },
    });
    emit({
      type: "auto-approval.reviewing",
      conversationId: "c1",
      callId: "k1",
      name: "bash",
      model: { provider: "demo", model: "demo-1" },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("auto approver (demo/demo-1) reviewing"));
    emit({
      type: "tool_call.completed",
      conversationId: "c1",
      callId: "k1",
      status: "ok",
      forModel: [{ type: "text", text: "done" }],
      annotations: {
        approval: {
          decision: "allow",
          responder: "auto",
          relationship: "out-of-workspace",
          model: { provider: "demo", model: "demo-1" },
        },
      },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("auto approver (demo/demo-1) approved"));
  });

  it("reprints a finalized tool's full output when verbose toggles", async () => {
    const { service, emit } = harness();
    const { stdin, lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "k1",
      name: "bash",
      args: { command: "npm test" },
    });
    emit({
      type: "tool_call.completed",
      conversationId: "c1",
      callId: "k1",
      status: "ok",
      forModel: [{ type: "text", text: "all good\nsecond line" }],
    });
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "completed" });
    // Finalized → compact: the successful command collapses into the work summary.
    await vi.waitFor(() => expect(lastFrame()).toContain("ran 1 command"));
    expect(lastFrame()).not.toContain("all good");
    expect(lastFrame()).not.toContain("second line");
    stdin.write("\x0f"); // Ctrl+O: wipe + reprint verbose
    await vi.waitFor(() => expect(lastFrame()).toContain("second line"));
  });

  it("shows an approval prompt and hides the composer while pending", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "request.created",
      requestId: "q1",
      conversationId: "c1",
      request: { kind: "approval", call: { name: "bash" } },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("approve bash?"));
    expect(lastFrame()).not.toContain("type a message");
  });
});

describe("appReduce: !cmd shell streaming", () => {
  it("starts a streaming cell, grows it per chunk, and finalizes with the exit code", () => {
    let s = appReduce(emptyState, { type: "shell-start", id: "sh1", command: "echo hi" });
    s = appReduce(s, { type: "shell-delta", id: "sh1", text: "hi\n" });
    s = appReduce(s, { type: "shell-delta", id: "sh1", text: "there\n" });
    expect(shellCells(s.cells)).toEqual([
      { kind: "shell", id: "sh1", command: "echo hi", text: "hi\nthere\n", streaming: true },
    ]);
    s = appReduce(s, { type: "shell-end", id: "sh1", exitCode: 3 });
    expect(shellCells(s.cells)[0]).toMatchObject({ streaming: false, exitCode: 3 });
  });

  it("bounds the live cell to a tail so a chatty command can't grow without limit", () => {
    let s = appReduce(emptyState, { type: "shell-start", id: "sh1", command: "yes" });
    s = appReduce(s, { type: "shell-delta", id: "sh1", text: "x".repeat(100_000) });
    expect(shellCells(s.cells)[0]!.text.length).toBe(16 * 1024);
  });

  it("ignores deltas for an already-finalized cell", () => {
    let s = appReduce(emptyState, { type: "shell-start", id: "sh1", command: "echo hi" });
    s = appReduce(s, { type: "shell-end", id: "sh1", exitCode: 0 });
    s = appReduce(s, { type: "shell-delta", id: "sh1", text: "late" });
    expect(shellCells(s.cells)[0]!.text).toBe("");
  });
});
