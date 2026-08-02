import { describe, expect, it } from "vitest";
import type { Cell } from "./transcript-reducer.ts";
import { formatDuration, layoutTranscript, liveEntryStartIndex } from "./transcript-layout.ts";

const user = (createdAt = 0): Extract<Cell, { kind: "user" }> => ({
  kind: "user",
  id: "u1",
  turnId: "t1",
  text: "inspect this",
  createdAt,
});

const tool = (
  callId: string,
  name: string,
  args: unknown,
  over: Partial<Extract<Cell, { kind: "tool" }>> = {},
): Extract<Cell, { kind: "tool" }> => ({
  kind: "tool",
  callId,
  turnId: "t1",
  name,
  args,
  startedAt: 1_000,
  completedAt: 2_000,
  status: "ok",
  output: "done",
  ...over,
});

const assistant = (id: string, text: string): Extract<Cell, { kind: "assistant" }> => ({
  kind: "assistant",
  turnId: "t1",
  id,
  text,
  streaming: false,
});

describe("layoutTranscript", () => {
  it("builds chronological thought/exploration stages and keeps commands explicit", () => {
    const cells: Cell[] = [
      user(),
      {
        kind: "reasoning",
        turnId: "t1",
        text: "private reasoning",
        streaming: false,
        startedAt: 500,
        completedAt: 1_500,
        observedTiming: true,
      },
      tool("r1", "read_file", { path: "README.md" }),
      tool("r2", "read_file", { path: "README.md" }),
      assistant("n1", "I found the data."),
      tool("g1", "glob", { pattern: "**/*.ts", path: "src" }),
      tool("c1", "bash", { command: "npm test" }),
      tool("c2", "bash", { command: "git status" }),
      assistant("a1", "done"),
    ];

    const compact = layoutTranscript(cells, undefined, false);
    expect(compact.map((entry) => entry.kind)).toEqual([
      "cell",
      "thought",
      "exploration",
      "cell",
      "exploration",
      "cell",
      "cell",
      "cell",
    ]);
    expect(compact[1]).toMatchObject({ kind: "thought", thought: { duration: 1_000 } });
    expect(compact[2]).toMatchObject({
      kind: "exploration",
      stage: {
        active: false,
        actions: [
          { callId: "r1", kind: "read", target: "README.md" },
          { callId: "r2", kind: "read", target: "README.md" },
        ],
      },
    });
    expect(compact[4]).toMatchObject({
      kind: "exploration",
      stage: {
        actions: [{ callId: "g1", kind: "search", target: "**/*.ts in src" }],
      },
    });
    expect(
      compact
        .filter(
          (entry): entry is Extract<(typeof compact)[number], { kind: "cell" }> =>
            entry.kind === "cell" && entry.cell.kind === "tool",
        )
        .map((entry) => (entry.cell.kind === "tool" ? entry.cell.callId : undefined)),
    ).toEqual(["c1", "c2"]);

    const verbose = layoutTranscript(cells, undefined, true);
    expect(verbose).toHaveLength(cells.length);
    expect(verbose.every((entry) => entry.kind === "cell")).toBe(true);
  });

  it("keeps a completed trailing exploration working until a semantic boundary", () => {
    const runningRead = tool("r1", "read_file", { path: "README.md" });
    delete runningRead.status;
    delete runningRead.completedAt;
    const running = layoutTranscript([user(), runningRead], "t1", false);
    const completed = layoutTranscript(
      [user(), tool("r1", "read_file", { path: "README.md" })],
      "t1",
      false,
    );

    expect(running[1]).toMatchObject({
      kind: "exploration",
      stage: { active: true, actions: [{ callId: "r1", target: "README.md" }] },
      live: true,
    });
    expect(completed[1]).toEqual(running[1]);
    expect(liveEntryStartIndex(completed)).toBe(1); // submitted prompt is already static

    const narrated = layoutTranscript(
      [user(), tool("r1", "read_file", { path: "README.md" }), assistant("a1", "found it")],
      "t1",
      false,
    );
    expect(narrated[1]).toMatchObject({
      kind: "exploration",
      stage: { active: false },
      live: false,
    });
  });

  it("does not freeze a bounded stage until its pending call can no longer fail", () => {
    const runningRead = tool("r1", "read_file", { path: "README.md" });
    delete runningRead.status;
    delete runningRead.completedAt;
    const cells: Cell[] = [
      user(),
      runningRead,
      { ...assistant("a1", "meanwhile"), streaming: true },
    ];
    const pending = layoutTranscript(cells, "t1", false);
    expect(pending[1]).toMatchObject({
      kind: "exploration",
      stage: { active: false },
      live: true,
    });
    expect(liveEntryStartIndex(pending)).toBe(1);

    const settled = layoutTranscript(
      [user(), tool("r1", "read_file", { path: "README.md" }), cells[2]!],
      "t1",
      false,
    );
    expect(settled[1]).toMatchObject({ kind: "exploration", live: false });
    expect(liveEntryStartIndex(settled)).toBe(2);
  });

  it("keeps failures and approvals explicit and splits surrounding exploration", () => {
    const approved = tool(
      "approved",
      "read_file",
      { path: "secret.txt" },
      {
        approval: { decision: "allow", responder: "human", relationship: "unknown" },
      },
    );
    const entries = layoutTranscript(
      [
        user(),
        tool("before", "read_file", { path: "before.ts" }),
        tool("failed", "read_file", { path: "missing.ts" }, { status: "error" }),
        tool("after", "glob", { pattern: "*.ts" }),
        approved,
      ],
      undefined,
      false,
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "cell",
      "exploration",
      "cell",
      "exploration",
      "cell",
    ]);
    expect(
      entries
        .filter((entry) => entry.kind === "cell" && entry.cell.kind === "tool")
        .map((entry) =>
          entry.kind === "cell" && entry.cell.kind === "tool" ? entry.cell.callId : "",
        ),
    ).toEqual(["failed", "approved"]);
  });

  it("settles a trailing exploration as Explored when the turn ends", () => {
    const entries = layoutTranscript(
      [user(), tool("r1", "read_file", { path: "README.md" })],
      undefined,
      false,
    );
    expect(entries[1]).toMatchObject({
      kind: "exploration",
      stage: { active: false },
      live: false,
    });
    expect(liveEntryStartIndex(entries)).toBe(entries.length);
  });
});

describe("duration formatting", () => {
  it("formats natural duration units", () => {
    expect(formatDuration(999)).toBe("<1s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});
