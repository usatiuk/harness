import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Box, Static, Text, render } from "ink";
import { Terminal } from "@xterm/headless";
import type { Conversation, HarnessEvent } from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { App, LiveViewport } from "./app.tsx";
import { Markdown } from "./markdown.tsx";

class TestOutput extends Writable {
  columns: number;
  rows: number;
  readonly isTTY = true;
  readonly chunks: string[] = [];

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

class TestInput extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

const asStdout = (stream: TestOutput): NodeJS.WriteStream =>
  stream as unknown as NodeJS.WriteStream;
const asStdin = (stream: TestInput): NodeJS.ReadStream => stream as unknown as NodeJS.ReadStream;

async function mount(
  node: React.ReactNode,
  {
    columns = 40,
    rows = 10,
    incrementalRendering = false,
  }: { columns?: number; rows?: number; incrementalRendering?: boolean } = {},
) {
  const stdout = new TestOutput(columns, rows);
  const stderr = new TestOutput(columns, rows);
  const stdin = new TestInput();
  const instance = render(node, {
    stdout: asStdout(stdout),
    stderr: asStdout(stderr),
    stdin: asStdin(stdin),
    exitOnCtrlC: false,
    incrementalRendering,
    interactive: true,
    patchConsole: false,
    maxFps: 120,
  });
  await instance.waitUntilRenderFlush();
  let offset = 0;

  return {
    ...instance,
    stdout,
    takeWrites(): string {
      const data = stdout.chunks.slice(offset).join("");
      offset = stdout.chunks.length;
      return data;
    },
  };
}

const writeTerminal = async (terminal: Terminal, data: string): Promise<void> => {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
};

const bufferText = (terminal: Terminal): string => {
  const buffer = terminal.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  ).join("\n");
};

const viewportText = (terminal: Terminal): string => {
  const buffer = terminal.buffer.active;
  return Array.from(
    { length: terminal.rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "",
  ).join("\n");
};

const occurrences = (text: string, marker: string): number => text.split(marker).length - 1;

function StreamingTranscript({
  complete,
  text,
}: {
  complete: boolean;
  text: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={complete ? [text] : []}>{(item) => <Markdown text={item} />}</Static>
      <LiveViewport header={complete ? undefined : <Text>LIVE-HEADER</Text>}>
        {complete ? null : <Markdown text={text} streaming />}
        <Text>LIVE-FOOTER</Text>
      </LiveViewport>
    </Box>
  );
}

const conversation = {
  id: "c1",
  config: { instructions: "", model: { provider: "demo", model: "demo-1" } },
  head: null,
  createdAt: 0,
} as unknown as Conversation;

function harness(): { service: HarnessService; emit: (event: HarnessEvent) => void } {
  let listener: ((event: HarnessEvent) => void) | undefined;
  const service = {
    subscribe: (_conversationId: unknown, next: (event: HarnessEvent) => void) => {
      listener = next;
      return () => (listener = undefined);
    },
    deliver: vi.fn(async () => {}),
    respond: vi.fn(),
    availableModels: () => [],
    service: () => undefined,
  } as unknown as HarnessService;
  return { service, emit: (event) => listener?.(event) };
}

describe("terminal scrollback", () => {
  it("shows the newest rich Markdown rows, then publishes the complete cell once", async () => {
    const text = [
      "# BEGIN-MARKER",
      "",
      ...Array.from({ length: 12 }, (_, index) => `paragraph ${index}`),
      "",
      "```ts",
      "const bottom = 'END-MARKER';",
      "```",
      "",
    ].join("\n");
    const terminal = new Terminal({
      cols: 50,
      rows: 8,
      scrollback: 200,
      allowProposedApi: true,
    });
    await writeTerminal(
      terminal,
      Array.from({ length: 30 }, (_, index) => `history-${index}\r\n`).join(""),
    );

    const view = await mount(<StreamingTranscript complete={false} text={text} />, {
      columns: 50,
      rows: 8,
      incrementalRendering: true,
    });
    const initialWrites = view.takeWrites();
    expect(initialWrites).toContain("LIVE-HEADER");
    await writeTerminal(terminal, initialWrites);
    const liveScreen = bufferText(terminal);
    expect(viewportText(terminal)).toContain("LIVE-HEADER");
    expect(liveScreen).toContain("END-MARKER");
    expect(liveScreen).not.toContain("BEGIN-MARKER");

    const baseBefore = terminal.buffer.active.baseY;
    terminal.scrollLines(-5);
    const viewportBefore = terminal.buffer.active.viewportY;
    view.rerender(
      <StreamingTranscript complete={false} text={text.replace("END-MARKER", "END-UPDATED")} />,
    );
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());
    expect(terminal.buffer.active.baseY).toBe(baseBefore);
    expect(terminal.buffer.active.viewportY).toBe(viewportBefore);

    view.rerender(<StreamingTranscript complete text={text} />);
    await view.waitUntilRenderFlush();
    const finalWrites = view.takeWrites();
    await writeTerminal(terminal, finalWrites);
    terminal.scrollToBottom();
    const finalBuffer = bufferText(terminal);
    expect(occurrences(finalBuffer, "BEGIN-MARKER")).toBe(1);
    expect(occurrences(finalBuffer, "END-MARKER")).toBe(1);

    view.unmount();
    await view.waitUntilExit();
    terminal.dispose();
  });

  it("publishes a clipped partial assistant message when its real App turn is aborted", async () => {
    const { service, emit } = harness();
    const terminal = new Terminal({
      cols: 50,
      rows: 10,
      scrollback: 200,
      allowProposedApi: true,
    });
    await writeTerminal(
      terminal,
      Array.from({ length: 20 }, (_, index) => `history-${index}\r\n`).join(""),
    );
    const view = await mount(
      <App
        service={service}
        conversation={conversation}
        initialItems={[]}
        initialUsage={[]}
        cwd="/tmp"
        launchCwd="/tmp"
        onResume={() => {}}
        onReload={() => {}}
        activities={{ peek: () => [], kill: () => {} }}
      />,
      { columns: 50, rows: 10, incrementalRendering: true },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writeTerminal(terminal, view.takeWrites());

    const text = [
      "ABORT-BEGIN",
      "",
      ...Array.from({ length: 12 }, (_, index) => `partial paragraph ${index}`),
      "",
      "ABORT-END",
      "",
    ].join("\n");
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({ type: "text_delta", conversationId: "c1", turnId: "t1", text });
    await vi.waitFor(() => expect(view.stdout.chunks.join("")).toContain("ABORT-END"));
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());
    expect(bufferText(terminal)).toContain("ABORT-END");
    expect(bufferText(terminal)).not.toContain("ABORT-BEGIN");

    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "aborted" });
    await vi.waitFor(() => expect(view.stdout.chunks.join("")).toContain("ABORT-BEGIN"));
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());
    terminal.scrollToBottom();
    const finalBuffer = bufferText(terminal);
    expect(occurrences(finalBuffer, "ABORT-BEGIN")).toBe(1);
    expect(occurrences(finalBuffer, "ABORT-END")).toBe(1);

    view.unmount();
    await view.waitUntilExit();
    terminal.dispose();
  });

  it("keeps an abandoned tool in scrollback after a later tall turn starts", async () => {
    const { service, emit } = harness();
    const terminal = new Terminal({
      cols: 50,
      rows: 10,
      scrollback: 200,
      allowProposedApi: true,
    });
    await writeTerminal(
      terminal,
      Array.from({ length: 20 }, (_, index) => `history-${index}\r\n`).join(""),
    );
    const view = await mount(
      <App
        service={service}
        conversation={conversation}
        initialItems={[]}
        initialUsage={[]}
        cwd="/tmp"
        launchCwd="/tmp"
        onResume={() => {}}
        onReload={() => {}}
        activities={{ peek: () => [], kill: () => {} }}
      />,
      { columns: 50, rows: 10, incrementalRendering: true },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writeTerminal(terminal, view.takeWrites());

    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "k1",
      name: "bash",
      args: { command: "TOOL-PIN-MARKER" },
    });
    await vi.waitFor(() => expect(view.stdout.chunks.join("")).toContain("TOOL-PIN-MARKER"));
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());

    emit({
      type: "turn.status",
      conversationId: "c1",
      turnId: "t1",
      status: "failed",
      error: "provider disconnected",
    });
    await vi.waitFor(() => expect(view.stdout.chunks.join("")).toContain("provider disconnected"));
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());

    const nextText = [
      ...Array.from({ length: 15 }, (_, index) => `next paragraph ${index}`),
      "NEXT-END",
      "",
    ].join("\n");
    emit({ type: "turn.status", conversationId: "c1", turnId: "t2", status: "running" });
    emit({ type: "text_delta", conversationId: "c1", turnId: "t2", text: nextText });
    await vi.waitFor(() => expect(view.stdout.chunks.join("")).toContain("NEXT-END"));
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());

    const afterNextTurn = bufferText(terminal);
    expect(occurrences(afterNextTurn, "TOOL-PIN-MARKER")).toBe(1);
    expect(afterNextTurn).toContain("NEXT-END");

    view.unmount();
    await view.waitUntilExit();
    terminal.dispose();
  });

  it("keeps the active exploration header visible when its children overflow", async () => {
    const { service, emit } = harness();
    const terminal = new Terminal({
      cols: 50,
      rows: 10,
      scrollback: 200,
      allowProposedApi: true,
    });
    const view = await mount(
      <App
        service={service}
        conversation={conversation}
        initialItems={[]}
        initialUsage={[]}
        cwd="/tmp"
        launchCwd="/tmp"
        onResume={() => {}}
        onReload={() => {}}
        activities={{ peek: () => [], kill: () => {} }}
      />,
      { columns: 50, rows: 10, incrementalRendering: true },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writeTerminal(terminal, view.takeWrites());

    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "running" });
    for (let index = 0; index < 12; index++) {
      emit({
        type: "tool_call.started",
        conversationId: "c1",
        callId: `read-${index}`,
        name: "read_file",
        args: { path: `FILE-${index}` },
      });
    }
    await vi.waitFor(() => expect(view.stdout.chunks.join("")).toContain("FILE-11"));
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());

    const viewport = viewportText(terminal);
    expect(viewport).toContain("Working");
    expect(viewport).toContain("Read FILE-11");
    expect(viewport).not.toContain("Read FILE-0");

    view.unmount();
    await view.waitUntilExit();
    terminal.dispose();
  });

  it("publishes settled thought/exploration stages once without routine tool cards", async () => {
    const { service, emit } = harness();
    const terminal = new Terminal({
      cols: 100,
      rows: 10,
      scrollback: 200,
      allowProposedApi: true,
    });
    const view = await mount(
      <App
        service={service}
        conversation={conversation}
        initialItems={[]}
        initialUsage={[]}
        cwd="/tmp"
        launchCwd="/tmp"
        onResume={() => {}}
        onReload={() => {}}
        activities={{ peek: () => [], kill: () => {} }}
      />,
      { columns: 100, rows: 10, incrementalRendering: true },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writeTerminal(terminal, view.takeWrites());

    const startedAt = Date.now();
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
        createdAt: startedAt,
        content: [{ type: "text", text: "inspect" }],
      },
    });
    emit({
      type: "reasoning",
      conversationId: "c1",
      item: {
        type: "reasoning",
        id: "r1",
        conversationId: "c1",
        turnId: "t1",
        seq: 1,
        parent: "u1",
        createdAt: startedAt,
        content: [{ type: "text", text: "private marker" }],
      },
    });
    emit({
      type: "tool_call.started",
      conversationId: "c1",
      callId: "read-1",
      name: "read_file",
      args: { path: "ROUTINE-FILE-MARKER" },
    });
    emit({
      type: "tool_call.completed",
      conversationId: "c1",
      callId: "read-1",
      status: "ok",
      forModel: [{ type: "text", text: "ROUTINE-OUTPUT-MARKER" }],
    });
    emit({
      type: "message",
      conversationId: "c1",
      item: {
        type: "message",
        role: "assistant",
        id: "a1",
        conversationId: "c1",
        turnId: "t1",
        seq: 4,
        parent: "r1",
        createdAt: Date.now(),
        content: [{ type: "text", text: "ANSWER-MARKER" }],
      },
    });
    emit({ type: "turn.status", conversationId: "c1", turnId: "t1", status: "completed" });
    await vi.waitFor(() => expect(view.stdout.chunks.join("")).toContain("Explored"));
    await view.waitUntilRenderFlush();
    await writeTerminal(terminal, view.takeWrites());
    terminal.scrollToBottom();

    const finalBuffer = bufferText(terminal);
    expect(occurrences(finalBuffer, "Thought")).toBe(1);
    expect(occurrences(finalBuffer, "Explored")).toBe(1);
    expect(finalBuffer).toContain("Read ROUTINE-FILE-MARKER");
    expect(finalBuffer).toContain("ANSWER-MARKER");
    expect(finalBuffer).not.toContain("ROUTINE-OUTPUT-MARKER");
    expect(finalBuffer).not.toContain("private marker");

    view.unmount();
    await view.waitUntilExit();
    terminal.dispose();
  });
});
