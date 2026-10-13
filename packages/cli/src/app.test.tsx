import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Conversation, HarnessEvent, Item } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { App, appReduce, usageLabel, type AppProps } from "./app.tsx";
import { emptyState, type Cell } from "./transcript-reducer.ts";
import { testPlugins } from "./test-plugins.ts";
import type { CliPlugins } from "./client-plugins.ts";

const shellCells = (cells: Cell[]): Extract<Cell, { kind: "shell" }>[] =>
  cells.filter((c): c is Extract<Cell, { kind: "shell" }> => c.kind === "shell");
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const toolCall = (callId: string, name: string, args: unknown): HarnessEvent => ({
  type: "item.appended",
  conversationId: "c1",
  item: {
    type: "tool_call",
    id: `tool-call:${callId}` as Item["id"],
    conversationId: "c1" as Item["conversationId"],
    turnId: "t1" as Item["turnId"],
    seq: 0,
    parent: null,
    createdAt: 0,
    callId,
    name,
    args,
  },
});

const toolResult = (
  callId: string,
  status: "ok" | "error",
  content: Extract<Item, { type: "tool_result" }>["content"],
  annotations?: Record<string, unknown>,
): HarnessEvent => ({
  type: "item.appended",
  conversationId: "c1",
  item: {
    type: "tool_result",
    id: `tool-result:${callId}` as Item["id"],
    conversationId: "c1" as Item["conversationId"],
    turnId: "t1" as Item["turnId"],
    seq: 1,
    parent: null,
    createdAt: 0,
    callId,
    status,
    content,
    ...(annotations === undefined ? {} : { annotations }),
  },
});

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
  plugins: CliPlugins = testPlugins(),
) =>
  render(
    <App
      service={service}
      plugins={plugins}
      conversation={conversation}
      initialItems={initialItems}
      initialUsage={[]}
      cwd="/tmp"
      launchCwd="/tmp"
      onResume={() => {}}
      onReload={onReload}
    />,
  );

describe("App", () => {
  it("forks a selected user message into an unsent draft", async () => {
    const { service } = harness();
    const target = {
      type: "message",
      id: "user-1",
      conversationId: "c1",
      turnId: "t1",
      seq: 0,
      parent: null,
      createdAt: 0,
      role: "user",
      content: [{ type: "text", text: "edit this" }],
    } as Item;
    const forkBefore = vi.fn(async () => ({
      conversation: { ...conversation, id: "fork" },
      draft: target.type === "message" ? target.content : [],
    }));
    const deliver = vi.fn();
    Object.assign(service, { forkBefore, deliver });
    const drafts = new Map<string, string>();
    const onResume = vi.fn();
    const app = render(
      <App
        service={service}
        plugins={testPlugins()}
        conversation={conversation}
        initialItems={[target]}
        initialUsage={[]}
        cwd="/tmp"
        launchCwd="/tmp"
        drafts={drafts}
        onResume={onResume}
        onReload={() => {}}
      />,
    );
    app.stdin.write("/fork");
    await flush();
    app.stdin.write("\r");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("Fork before a user message"));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(onResume).toHaveBeenCalledWith("fork"));
    expect(forkBefore).toHaveBeenCalledWith("c1", "user-1");
    expect(drafts.get("fork")).toBe("edit this");
    expect(deliver).not.toHaveBeenCalled();
    app.unmount();
  });
  it("labels totals as incomplete when a provider omitted usage", () => {
    expect(
      usageLabel(
        { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
        true,
        0,
        undefined,
        1000,
      ),
    ).toBe("usage incomplete");
    expect(
      usageLabel(
        { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0 },
        true,
        0,
        undefined,
        1000,
      ),
    ).toContain("usage incomplete");
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
      type: "item.appended",
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
    emit(toolCall("read-1", "read_file", { path: "README.md" }));
    await vi.waitFor(() => expect(lastFrame()).toContain("• Explored\n  └ Read README.md"));
    expect(lastFrame()).toContain("Working…");
    expect(lastFrame()!.match(/Read README\.md/gu)).toHaveLength(1);

    emit(toolResult("read-1", "ok", [{ type: "text", text: "# Harness" }]));
    await vi.waitFor(() => expect(lastFrame()).toContain("• Explored\n  └ Read README.md"));
    expect(lastFrame()!.match(/Read README\.md/gu)).toHaveLength(1);

    emit({ type: "text_delta", conversationId: "c1", turnId: "t1", text: "I found the data" });
    await vi.waitFor(() => expect(lastFrame()).toContain("I found the data"));
    expect(lastFrame()).toContain("• Explored");
    expect(lastFrame()).toContain("I found the data");
    expect(lastFrame()).toContain("Working…");
    emit({
      type: "item.appended",
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
    emit(toolCall("search-1", "glob", { pattern: "text_delta" }));
    await vi.waitFor(() => expect(lastFrame()).toContain("• Explored\n  └ Search text_delta"));
    expect(lastFrame()!.match(/Explored/gu)).toHaveLength(2);

    emit(toolResult("search-1", "ok", [{ type: "text", text: "packages/cli/src/app.tsx" }]));
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "completed" });
    await vi.waitFor(() => expect(lastFrame()).toContain("• Worked for"));
    expect(lastFrame()!.match(/Explored/gu)).toHaveLength(2);
    expect(lastFrame()).not.toContain("Working…");
    const lines = lastFrame()!.split("\n");
    const workedLine = lines.findIndex((line) => line.includes("Worked for"));
    expect(lines[workedLine - 1]).toBe("");
    expect(lines[workedLine + 1]).toBe("");
  });

  it("keeps pending stages in chronological order when narration starts another stage", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit(toolCall("command-1", "bash", { command: "echo pending" }));
    emit(toolCall("read-1", "read_file", { path: "README.md" }));
    emit({ type: "text_delta", conversationId: "c1", turnId: "t1", text: "I found a lead" });
    emit(toolCall("read-2", "read_file", { path: "package.json" }));

    await vi.waitFor(() => expect(lastFrame()).toContain("Read package.json"));
    const frame = lastFrame()!;
    expect(frame.indexOf("echo pending")).toBeLessThan(frame.indexOf("Read README.md"));
    expect(frame.indexOf("Read README.md")).toBeLessThan(frame.indexOf("I found a lead"));
    expect(frame.indexOf("I found a lead")).toBeLessThan(frame.indexOf("Read package.json"));
    expect(frame.indexOf("Read package.json")).toBeLessThan(frame.indexOf("Working…"));
  });

  it("routes one-shot shell execution through the client plugin boundary", async () => {
    const { service } = harness();
    const runShell = vi.fn<CliPlugins["runShell"]>((_conversationId, _command, emit) => {
      const accepted = Promise.resolve().then(() => {
        emit("shell-test", { type: "data", text: "watched\n" });
        emit("shell-test", { type: "exited", exitCode: 0 });
      });
      return { id: "shell-test", accepted };
    });
    const { stdin, lastFrame } = mount(service, [], () => {}, testPlugins({ runShell }));

    stdin.write("!watch");
    await flush();
    stdin.write("\r");
    await vi.waitFor(() => expect(runShell).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lastFrame()).toContain("watched"));
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
    expect(lastFrame()!.indexOf("Hello there")).toBeLessThan(lastFrame()!.indexOf("Working…"));
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
    const liveFrame = lastFrame()!;
    expect(liveFrame.indexOf("considering the boundary")).toBeLessThan(
      liveFrame.indexOf("Working…"),
    );
    const liveLines = liveFrame.split("\n");
    const workingLine = liveLines.findIndex((line) => line.includes("Working…"));
    expect(liveLines[workingLine - 1]).toBe("");
    expect(liveLines[workingLine + 1]).toBe("");
    emit({
      type: "item.appended",
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
    expect(lastFrame()!.indexOf("Thought for")).toBeLessThan(lastFrame()!.indexOf("Working…"));
  });

  it("collapses a running tool's args by default and expands them on Ctrl+O", async () => {
    const { service, emit } = harness();
    const { stdin, lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit(toolCall("k1", "bash", { command: "npm test" }));
    // Compact: the command is shown as a summary, the raw args JSON is not.
    await vi.waitFor(() => expect(lastFrame()).toContain("npm test"));
    expect(lastFrame()).toContain("Working…");
    expect(lastFrame()).not.toContain('"command"');
    stdin.write("\x0f"); // Ctrl+O toggles verbose
    // Verbose: the full args blob renders for the still-live cell.
    await vi.waitFor(() => expect(lastFrame()).toContain('"command"'));
  });

  it("renders live auto-review progress and the final saved decision", async () => {
    const { service, emit } = harness();
    const { lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit(toolCall("k1", "bash", { command: "echo hi" }));
    emit({
      type: "auto-approval.reviewing",
      conversationId: "c1",
      callId: "k1",
      name: "bash",
      model: { provider: "demo", model: "demo-1" },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("auto approver (demo/demo-1) reviewing"));
    emit(
      toolResult("k1", "ok", [{ type: "text", text: "done" }], {
        approval: {
          decision: "allow",
          responder: "auto",
          relationship: "out-of-workspace",
          model: { provider: "demo", model: "demo-1" },
        },
      }),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("auto approver (demo/demo-1) approved"));
  });

  it("reprints a finalized tool's full output when verbose toggles", async () => {
    const { service, emit } = harness();
    const { stdin, lastFrame } = mount(service);
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit(toolCall("k1", "bash", { command: "npm test" }));
    emit(toolResult("k1", "ok", [{ type: "text", text: "all good\nsecond line" }]));
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
    emit(toolCall("k1", "read_file", { path: "secret.txt" }));
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
    expect(lastFrame()).toContain("Working…");
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
