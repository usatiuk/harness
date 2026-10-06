import { expect, it } from "vitest";
import type { Cell } from "@harness/client-features/transcript-reducer";
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
  const liveKey = transcript.rows[1]!.key;
  const earlier: Cell = { ...stream, text: "Earlier", streaming: false, id: "earlier" };
  const parent: Cell = { kind: "tool", callId: "parent", name: "eval", args: {}, startedAt: 0 };
  transcript.update([earlier, parent, child, stream]);
  expect(transcript.rows[0]!.key).not.toBe(liveKey);
  expect(transcript.rows[1]!.children).toEqual([child]);
  expect(transcript.rows[2]!.key).toBe(liveKey);
  const finished: Cell = { ...stream, streaming: false, id: "live" };
  transcript.update([earlier, parent, child, finished]);
  expect(transcript.rows[2]!.key).toBe(liveKey);
});
