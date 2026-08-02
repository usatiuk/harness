import { describe, expect, it } from "vitest";
import type { Cell } from "./transcript-reducer.ts";
import {
  formatDuration,
  formatWorkSummary,
  layoutTranscript,
  liveEntryStartIndex,
} from "./transcript-layout.ts";

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

describe("layoutTranscript", () => {
  it("collapses successful routine work into one summary and keeps exceptional tools", () => {
    const cells: Cell[] = [
      user(),
      {
        kind: "reasoning",
        turnId: "t1",
        text: "private reasoning",
        streaming: false,
        startedAt: 500,
        completedAt: 1_000,
      },
      tool("r1", "read_file", { path: "README.md" }),
      tool("r2", "read_file", { path: "README.md" }),
      tool("r3", "read_file", { path: "package.json" }),
      tool("g1", "glob", { pattern: "**/*" }),
      tool("c1", "bash", { command: "npm test" }),
      tool(
        "approved",
        "bash",
        { command: "git status" },
        {
          approval: { decision: "allow", responder: "human", relationship: "unknown" },
        },
      ),
      tool("failed", "read_file", { path: "missing" }, { status: "error", output: "missing" }),
      tool("edit", "edit", { path: "a.ts", old_string: "a", new_string: "b" }),
      tool("plugin", "plugin_tool", { value: true }),
      {
        kind: "assistant",
        turnId: "t1",
        id: "a1",
        text: "done",
        streaming: false,
      },
    ];

    const compact = layoutTranscript(cells, undefined, false);
    const work = compact.find((entry) => entry.kind === "work");
    expect(work).toMatchObject({
      kind: "work",
      summary: { filesRead: 2, searches: 1, commands: 2, active: false },
    });
    expect(compact.filter((entry) => entry.kind === "work")).toHaveLength(1);
    expect(
      compact
        .filter(
          (entry): entry is Extract<(typeof compact)[number], { kind: "cell" }> =>
            entry.kind === "cell",
        )
        .map((entry) => entry.cell)
        .filter((cell): cell is Extract<Cell, { kind: "tool" }> => cell.kind === "tool")
        .map((cell) => cell.callId),
    ).toEqual(["approved", "failed", "edit", "plugin"]);

    const verbose = layoutTranscript(cells, undefined, true);
    expect(verbose.filter((entry) => entry.kind === "work")).toHaveLength(1);
    expect(
      verbose.filter((entry) => entry.kind === "cell" && entry.cell.kind === "reasoning"),
    ).toHaveLength(1);
    expect(
      verbose.filter((entry) => entry.kind === "cell" && entry.cell.kind === "tool"),
    ).toHaveLength(9);
  });

  it("keeps the entire active turn live and settles it as one static prefix", () => {
    const cells: Cell[] = [user(), tool("r1", "read_file", { path: "README.md" })];
    const live = layoutTranscript(cells, "t1", false);
    expect(liveEntryStartIndex(live)).toBe(0);
    expect(live.find((entry) => entry.kind === "work")).toMatchObject({
      kind: "work",
      summary: { active: true },
    });

    const settled = layoutTranscript(cells, undefined, false);
    expect(liveEntryStartIndex(settled)).toBe(settled.length);
    expect(settled.find((entry) => entry.kind === "work")).toMatchObject({
      kind: "work",
      summary: { active: false },
    });
  });

  it("does not manufacture a work summary for an edit-only turn", () => {
    const entries = layoutTranscript(
      [user(), tool("edit", "edit", { path: "a.ts", old_string: "a", new_string: "b" })],
      undefined,
      false,
    );
    expect(entries.some((entry) => entry.kind === "work")).toBe(false);
  });

  it("removes a provisional summary when the turn contains only a failed routine call", () => {
    const runningRead = tool("read", "read_file", { path: "missing" });
    delete runningRead.status;
    delete runningRead.completedAt;
    const running = layoutTranscript([user(), runningRead], "t1", false);
    expect(running.some((entry) => entry.kind === "work")).toBe(true);

    const failed = layoutTranscript(
      [user(), tool("read", "read_file", { path: "missing" }, { status: "error" })],
      undefined,
      false,
    );
    expect(failed.some((entry) => entry.kind === "work")).toBe(false);
  });
});

describe("work summary formatting", () => {
  it("formats duration units and natural count grammar", () => {
    expect(formatDuration(999)).toBe("<1s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(
      formatWorkSummary({
        active: false,
        startedAt: 0,
        completedAt: 12_000,
        filesRead: 1,
        searches: 2,
        commands: 1,
      }),
    ).toBe("Worked for 12s · read 1 file · 2 searches · ran 1 command");
  });

  it("uses a non-ticking live label", () => {
    expect(
      formatWorkSummary({
        active: true,
        startedAt: 0,
        completedAt: 5_000,
        filesRead: 2,
        searches: 0,
        commands: 0,
      }),
    ).toBe("Working… · read 2 files");
  });
});
