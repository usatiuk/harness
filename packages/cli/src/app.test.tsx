import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation, ConversationId, HarnessEvent, Item } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { LocalExecutionContext, type ProcessExit, type SpawnedProcess } from "@harness/execution";
import { ActivityManager } from "@harness/activities";
import { DockerExecutionContext, NativeExecutionContext } from "@harness/sandbox";
import { App, appReduce, sandboxBackendOf, type AppProps } from "./app.tsx";
import { emptyState, type Cell } from "./transcript-reducer.ts";

const shellCells = (cells: Cell[]): Extract<Cell, { kind: "shell" }>[] =>
  cells.filter((c): c is Extract<Cell, { kind: "shell" }> => c.kind === "shell");
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const conversation = {
  id: "c1",
  config: { instructions: "", model: { provider: "demo", model: "demo-1" } },
  head: null,
  createdAt: 0,
} as unknown as Conversation;

function harness(): {
  service: HarnessService;
  emit: (e: HarnessEvent) => void;
  setPluginConfig: ReturnType<typeof vi.fn>;
} {
  let listener: ((e: HarnessEvent) => void) | undefined;
  const setPluginConfig = vi.fn(async () => {});
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
    setPluginConfig,
  } as unknown as HarnessService;
  return { service, emit: (e) => listener?.(e), setPluginConfig };
}

// React commits emitted updates asynchronously (scheduler ticks), so frame assertions
// after an emit poll with vi.waitFor instead of racing the commit with a timer.
const mount = (
  service: HarnessService,
  initialItems: Item[] = [],
  onReload: AppProps["onReload"] = () => {},
) =>
  render(
    <App
      service={service}
      conversation={conversation}
      initialItems={initialItems}
      initialUsage={[]}
      cwd="/tmp"
      launchCwd="/tmp"
      onResume={() => {}}
      onReload={onReload}
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

  it("routes a sandbox setting through reload before persisting it", async () => {
    const { service, setPluginConfig } = harness();
    const onReload = vi.fn<AppProps["onReload"]>();
    const { stdin } = mount(service, [], onReload);

    stdin.write("/sandbox native");
    await flush();
    stdin.write("\r");
    await flush();

    await vi.waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const mutation = onReload.mock.calls[0]![0]!;
    expect(setPluginConfig).not.toHaveBeenCalled();
    await mutation.apply();
    expect(setPluginConfig).toHaveBeenCalledWith(
      conversation.id,
      "sandbox",
      { backend: "native" },
      { saveGlobal: true },
    );
  });

  it("refuses reload while the foreground turn is active", async () => {
    const { service, emit } = harness();
    const onReload = vi.fn<AppProps["onReload"]>();
    const { stdin, lastFrame } = mount(service, [], onReload);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    await vi.waitFor(() => expect(lastFrame()).toContain("Working"));

    stdin.write("/reload");
    await flush();
    stdin.write("\r");
    await flush();

    await vi.waitFor(() => expect(lastFrame()).toContain("interrupt the current turn"));
    expect(onReload).not.toHaveBeenCalled();
  });

  it("keeps exploration stable until narration closes it, then starts a new stage", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "message",
      conversationId: "c1",
      item: {
        type: "message",
        role: "user",
        id: "u1",
        conversationId: "c1",
        turnId: "t1",
        seq: 0,
        parent: null,
        createdAt: 1,
        content: [{ type: "text", text: "inspect" }],
      },
    });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "read-1",
      name: "read_file",
      args: { path: "README.md" },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("Working…\n  └ Read README.md"));
    expect(lastFrame()!.match(/Read README\.md/gu)).toHaveLength(1);

    emit({
      type: "tool_call.completed",
      conversationId: "c1",
      callId: "read-1",
      status: "ok",
      forModel: [{ type: "text", text: "# Harness" }],
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("Working…\n  └ Read README.md"));
    expect(lastFrame()!.match(/Read README\.md/gu)).toHaveLength(1);

    emit({ type: "text_delta", conversationId: "c1", turnId: "t1", text: "I found the data" });
    await vi.waitFor(() => expect(lastFrame()).toContain("• Explored"));
    expect(lastFrame()).toContain("I found the data");
    expect(lastFrame()).not.toContain("Working…");
    emit({
      type: "message",
      conversationId: "c1",
      item: {
        type: "message",
        role: "assistant",
        id: "n1",
        conversationId: "c1",
        turnId: "t1",
        seq: 1,
        parent: null,
        createdAt: 1,
        content: [{ type: "text", text: "I found the data" }],
      },
    });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "search-1",
      name: "glob",
      args: { pattern: "text_delta" },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("Working…\n  └ Search text_delta"));
    expect(lastFrame()!.match(/Explored/gu)).toHaveLength(1);

    emit({
      type: "tool_call.completed",
      conversationId: "c1",
      callId: "search-1",
      status: "ok",
      forModel: [{ type: "text", text: "packages/cli/src/app.tsx" }],
    });
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "completed" });
    await vi.waitFor(() => expect(lastFrame()!.match(/Explored/gu)).toHaveLength(2));
    expect(lastFrame()).not.toContain("Working…");
  });

  it("keeps pending stages in chronological order when narration starts another stage", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "command-1",
      name: "bash",
      args: { command: "echo pending" },
    });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "read-1",
      name: "read_file",
      args: { path: "README.md" },
    });
    emit({ type: "text_delta", conversationId: "c1", turnId: "t1", text: "I found a lead" });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "read-2",
      name: "read_file",
      args: { path: "package.json" },
    });

    await vi.waitFor(() => expect(lastFrame()).toContain("Read package.json"));
    const frame = lastFrame()!;
    expect(frame.indexOf("echo pending")).toBeLessThan(frame.indexOf("Read README.md"));
    expect(frame.indexOf("Read README.md")).toBeLessThan(frame.indexOf("I found a lead"));
    expect(frame.indexOf("I found a lead")).toBeLessThan(frame.indexOf("Working…"));
    expect(frame.indexOf("Working…")).toBeLessThan(frame.indexOf("Read package.json"));
  });

  it("registers one-shot shell processes for session teardown", async () => {
    const { service } = harness();
    const manager = new ActivityManager(conversation.id);
    let settle!: (result: ProcessExit) => void;
    let kills = 0;
    const proc: SpawnedProcess = {
      pid: 1,
      exit: new Promise((resolve) => (settle = resolve)),
      onData: () => {},
      kill: () => {
        kills++;
        settle({ code: null, signal: "SIGTERM" });
      },
    };
    Object.assign(service, {
      service: (_id: ConversationId, key: string) =>
        key === "execution" ? { spawn: () => proc } : key === "activities" ? manager : undefined,
    });
    const { stdin } = mount(service);

    stdin.write("!watch");
    await flush();
    stdin.write("\r");
    await flush();
    expect(manager.runningCount()).toBe(1);

    await manager.dispose();
    expect(kills).toBe(1);
    expect(manager.runningCount()).toBe(0);
  });

  it("reconstructs thought and exploration stages from resumed items", () => {
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
    expect(lastFrame()).toContain(
      "› inspect\n\n• Thought\n\n• Explored\n  └ Read README.md\n\n  done",
    );
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

  it("shows live reasoning and settles it as a timed thought", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "reasoning_delta",
      conversationId: "c1",
      turnId: "t1",
      text: "considering the boundary",
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("considering the boundary"));
    emit({
      type: "reasoning",
      conversationId: "c1",
      item: {
        type: "reasoning",
        id: "reasoning-1",
        conversationId: "c1",
        turnId: "t1",
        seq: 1,
        parent: null,
        createdAt: Date.now(),
        content: [{ type: "text", text: "considering the boundary" }],
      },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("• Thought for"));
    expect(lastFrame()).not.toContain("considering the boundary");
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
    // Commands stay explicit; compact mode keeps one result line and verbose restores the rest.
    await vi.waitFor(() => expect(lastFrame()).toContain("all good"));
    expect(lastFrame()).not.toContain("second line");
    stdin.write("\x0f"); // Ctrl+O: wipe + reprint verbose
    await vi.waitFor(() => expect(lastFrame()).toContain("second line"));
  });

  it("shows an approval prompt and hides the composer while pending", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "k1",
      name: "read_file",
      args: { path: "secret.txt" },
    });
    emit({
      type: "request.created",
      requestId: "q1",
      conversationId: "c1",
      request: {
        kind: "approval",
        call: { callId: "k1", name: "read_file", args: { path: "secret.txt" } },
        relationship: "unknown",
      },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("approve read_file?"));
    expect(lastFrame()).toContain("secret.txt");
    expect(lastFrame()).not.toContain("Working…");
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
