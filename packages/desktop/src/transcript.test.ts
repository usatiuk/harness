import { expect, it, vi } from "vitest";
import type { Cell } from "@harness/client-features/transcript-reducer";
import type { TranscriptRow } from "./transcript.ts";
import { DesktopTranscript } from "./transcript.ts";

it("retains row identity through growth, commit, interruption and multiple blocks in a turn", () => {
  const transcript = new DesktopTranscript();
  const first: Cell = { kind: "assistant", turnId: "turn", text: "First", streaming: true };
  transcript.update([first]);
  const firstKey = transcript.rows[0]!.key;
  const grown: Cell = { ...first, text: "First block" };
  transcript.update([grown]);
  expect(transcript.rows[0]!.key).toBe(firstKey);
  const committed: Cell = { ...grown, streaming: false, id: "message1" };
  transcript.update([committed]);
  expect(transcript.rows[0]!.key).toBe(firstKey);
  const second: Cell = { kind: "assistant", turnId: "turn", text: "Second", streaming: true };
  transcript.update([committed, second]);
  const secondKey = transcript.rows[1]!.key;
  expect(secondKey).not.toBe(firstKey);
  transcript.update([committed, { ...second, streaming: false }]);
  expect(transcript.rows.map((row) => row.key)).toEqual([firstKey, secondKey]);
});

it("does not give earlier same-turn history the live stream's key and keeps newly loaded parents and children flat", () => {
  const transcript = new DesktopTranscript();
  const stream: Cell = {
    kind: "reasoning",
    turnId: "turn",
    text: "Live",
    streaming: true,
    startedAt: 1,
  };
  const child: Cell = {
    kind: "tool",
    callId: "child",
    parentCallId: "parent",
    name: "read",
    args: {},
    startedAt: 1,
  };
  transcript.update([child, stream]);
  const liveKey = toolGroup(transcript.rows[0]!).steps[1]!.key;
  const earlier: Cell = { ...stream, text: "Earlier", streaming: false, id: "earlier" };
  const parent: Cell = { kind: "tool", callId: "parent", name: "eval", args: {}, startedAt: 0 };
  transcript.update([earlier, parent, child, stream]);
  const steps = toolGroup(transcript.rows[0]!).steps;
  expect(steps[0].key).not.toBe(liveKey);
  expect(steps[1]).toMatchObject({ cell: parent, boundary: "begin" });
  expect(steps[2]).toMatchObject({ cell: child });
  expect(steps[3]!.key).toBe(liveKey);
  const finished: Cell = { ...stream, streaming: false, id: "live" };
  transcript.update([earlier, parent, child, finished]);
  expect(toolGroup(transcript.rows[0]!).steps[3]!.key).toBe(liveKey);
});

it("groups consecutive calls between messages while showing child operations once without nesting", () => {
  const transcript = new DesktopTranscript();
  const call = (callId: string): Extract<Cell, { kind: "tool" }> => ({
    kind: "tool",
    callId,
    name: "read",
    args: {},
    startedAt: 0,
  });
  const first = call("first");
  const second = call("second");
  const child: Cell = { ...call("child"), parentCallId: "first" };
  const message: Cell = { kind: "assistant", turnId: "turn", text: "Update", streaming: false };
  transcript.update([first]);
  const key = transcript.rows[0]!.key;
  const thought: Cell = {
    kind: "reasoning",
    turnId: "turn",
    text: "Checking",
    streaming: false,
    id: "thought",
    startedAt: 0,
  };
  transcript.update([first, thought, second, child, message, call("third")]);
  expect(transcript.rows).toHaveLength(3);
  expect(transcript.rows[0]!.key).toBe(key);
  expect(toolGroup(transcript.rows[0]!).steps.map((row) => row.cell)).toEqual([
    first,
    thought,
    second,
    child,
  ]);
  expect(transcript.rows[1]).toMatchObject({ kind: "cell", cell: message });
  expect(toolGroup(transcript.rows[2]!).steps).toHaveLength(1);
});

function toolGroup(row: TranscriptRow): Extract<TranscriptRow, { kind: "steps" }> {
  if (row.kind !== "steps") throw new Error("Expected tool group");
  return row;
}

it("places eval results after all available descendants, including nested evals", () => {
  const transcript = new DesktopTranscript();
  const call = (
    callId: string,
    name: string,
    parentCallId?: string,
  ): Extract<Cell, { kind: "tool" }> => ({
    kind: "tool",
    callId,
    name,
    args: {},
    startedAt: 0,
    status: "ok",
    output: callId,
    ...(parentCallId ? { parentCallId } : {}),
  });
  const parent = call("parent", "eval");
  const nested = call("nested", "eval", "parent");
  const leaf = call("leaf", "read_file", "nested");
  const sibling = call("sibling", "exec", "parent");
  transcript.update([parent, nested, leaf, sibling]);
  const steps = toolGroup(transcript.rows[0]!).steps;
  expect(
    steps.map((step) => [
      step.cell.kind === "tool" ? step.cell.callId : "",
      "boundary" in step ? step.boundary : undefined,
    ]),
  ).toEqual([
    ["parent", "begin"],
    ["nested", "begin"],
    ["leaf", undefined],
    ["nested", "result"],
    ["sibling", undefined],
    ["parent", "result"],
  ]);
  expect(new Set(steps.map((step) => step.key)).size).toBe(steps.length);
  const { status: parentStatus, ...runningParent } = parent;
  const { status: nestedStatus, ...runningNested } = nested;
  expect(parentStatus).toBe("ok");
  expect(nestedStatus).toBe("ok");
  transcript.update([runningParent, runningNested, leaf, sibling]);
  expect(toolGroup(transcript.rows[0]!).steps).toHaveLength(4);
});

it("keeps synthetic Eval results distinct from suffix-bearing call IDs", () => {
  const transcript = new DesktopTranscript();
  transcript.update([
    { kind: "tool", callId: "call", name: "eval", args: {}, startedAt: 0, status: "ok" },
    {
      kind: "tool",
      callId: "call:result",
      parentCallId: "call",
      name: "read_file",
      args: {},
      startedAt: 1,
      status: "ok",
    },
  ]);
  const steps = toolGroup(transcript.rows[0]!).steps;
  expect(steps).toHaveLength(3);
  expect(new Set(steps.map((step) => step.key)).size).toBe(3);
});

it("observes live group elapsed time with the client clock regardless of server skew", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_000);
    const transcript = new DesktopTranscript();
    const thought: Extract<Cell, { kind: "reasoning" }> = {
      kind: "reasoning",
      turnId: "turn",
      text: "Checking",
      streaming: true,
      startedAt: 100_000,
      observedTiming: true,
    };
    const tool: Extract<Cell, { kind: "tool" }> = {
      kind: "tool",
      callId: "read",
      name: "read_file",
      args: {},
      startedAt: 40_000,
    };
    transcript.update([thought, tool]);
    expect(toolGroup(transcript.rows[0]!).observedTiming).toEqual({ startedAt: 100_000 });
    vi.setSystemTime(101_000);
    const earlier: Extract<Cell, { kind: "tool" }> = {
      ...tool,
      callId: "earlier",
      status: "ok",
      completedAt: 40_500,
    };
    transcript.update([earlier, thought, tool]);
    expect(toolGroup(transcript.rows[0]!).observedTiming).toEqual({ startedAt: 100_000 });
    vi.setSystemTime(102_000);
    transcript.update([
      earlier,
      { ...thought, streaming: false, id: "thought", completedAt: 42_000 },
      { ...tool, status: "ok", completedAt: 42_000 },
    ]);
    expect(toolGroup(transcript.rows[0]!).observedTiming).toEqual({
      startedAt: 100_000,
      completedAt: 102_000,
    });
    vi.setSystemTime(110_000);
    transcript.update([
      ...transcript.rows.flatMap<Cell>((row) =>
        row.kind === "steps" ? row.steps.map((step) => step.cell) : [row.cell],
      ),
    ]);
    expect(toolGroup(transcript.rows[0]!).observedTiming?.completedAt).toBe(102_000);
    const reopened = new DesktopTranscript();
    reopened.update([{ ...tool, status: "ok", completedAt: 42_000 }]);
    expect(toolGroup(reopened.rows[0]!).observedTiming).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
