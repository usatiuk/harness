import { expect, it } from "vitest";
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

it("does not give earlier same-turn history the live stream's key and groups newly loaded parents", () => {
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
  expect(steps[1]).toMatchObject({ cell: parent, children: [child] });
  expect(steps[2]!.key).toBe(liveKey);
  const finished: Cell = { ...stream, streaming: false, id: "live" };
  transcript.update([earlier, parent, child, finished]);
  expect(toolGroup(transcript.rows[0]!).steps[2]!.key).toBe(liveKey);
});

it("groups consecutive calls between messages while retaining nested operations and identities", () => {
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
  ]);
  expect(toolGroup(transcript.rows[0]!).steps[0]).toMatchObject({ children: [child] });
  expect(transcript.rows[1]).toMatchObject({ kind: "cell", cell: message });
  expect(toolGroup(transcript.rows[2]!).steps).toHaveLength(1);
});

function toolGroup(row: TranscriptRow): Extract<TranscriptRow, { kind: "steps" }> {
  if (row.kind !== "steps") throw new Error("Expected tool group");
  return row;
}
