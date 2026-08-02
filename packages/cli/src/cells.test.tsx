import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { Cell } from "./transcript-reducer.ts";
import {
  CellView,
  ExplorationView,
  ThoughtView,
  toolSummary,
  VerboseContext,
  WorkFooterView,
} from "./cells.tsx";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const frame = async (cell: Cell, verbose = false): Promise<string | undefined> => {
  const view = <CellView cell={cell} />;
  const tree = verbose ? (
    <VerboseContext.Provider value={true}>{view}</VerboseContext.Provider>
  ) : (
    view
  );
  const { lastFrame } = render(tree);
  await flush();
  return lastFrame();
};

describe("toolSummary", () => {
  it("prefers the command/path/pattern field", () => {
    expect(toolSummary({ command: "npm test" })).toBe("npm test");
    expect(toolSummary({ path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolSummary({ pattern: "TODO" })).toBe("TODO");
  });

  it("falls back to a truncated JSON blob for unknown shapes", () => {
    expect(toolSummary({ foo: "bar" })).toBe('{"foo":"bar"}');
  });
});

describe("CellView: tool cards", () => {
  const okTool: Extract<Cell, { kind: "tool" }> = {
    kind: "tool",
    callId: "k1",
    turnId: "t1",
    name: "bash",
    args: { command: "npm test" },
    startedAt: 0,
    completedAt: 1,
    status: "ok",
    output: "all good\nsecond line",
  };

  it("compact: shows a one-line result, hiding the rest of the output", async () => {
    const f = (await frame(okTool))!;
    expect(f).toContain("bash");
    expect(f).toContain("npm test");
    expect(f).toContain("all good");
    expect(f).not.toContain("second line");
  });

  it("verbose: shows full args and the full output", async () => {
    const f = (await frame(okTool, true))!;
    expect(f).toContain('"command":"npm test"');
    expect(f).toContain("second line");
  });

  it("compact ok with no output shows `⎿ done`", async () => {
    const f = (await frame({ ...okTool, output: "" }))!;
    expect(f).toContain("done");
  });

  it("compact error surfaces the error line", async () => {
    const f = (await frame({ ...okTool, status: "error", output: "boom" }))!;
    expect(f).toContain("boom");
  });

  it("shows an approval denial once instead of repeating its tool error", async () => {
    const denied: Cell = {
      ...okTool,
      status: "error",
      output: "tool 'bash' denied by auto-approval: unsafe",
      approval: {
        decision: "deny",
        responder: "auto",
        relationship: "unknown",
        reason: "unsafe",
      },
    };
    for (const verbose of [false, true]) {
      const f = (await frame(denied, verbose))!;
      expect(f).toContain("auto approver denied: unsafe");
      expect(f).not.toContain("tool 'bash' denied by auto-approval");
    }
  });

  it("a running tool (no status) shows no result line", async () => {
    const running: Cell = {
      kind: "tool",
      callId: "k2",
      turnId: "t1",
      name: "bash",
      args: { command: "ls" },
      startedAt: 0,
    };
    const f = (await frame(running))!;
    expect(f).toContain("ls");
    expect(f).not.toContain("done");
  });
});

describe("CellView: reasoning", () => {
  const finalized: Extract<Cell, { kind: "reasoning" }> = {
    kind: "reasoning",
    turnId: "t1",
    text: "deep inner monologue here",
    streaming: false,
    startedAt: 0,
    completedAt: 1,
  };

  it("compact: finalized reasoning collapses to a marker", async () => {
    const f = (await frame(finalized))!;
    expect(f).toContain("thought");
    expect(f).not.toContain("deep inner monologue");
  });

  it("verbose: finalized reasoning shows the full text", async () => {
    const f = (await frame(finalized, true))!;
    expect(f).toContain("deep inner monologue");
  });

  it("streaming reasoning shows the full text even when compact", async () => {
    const streaming: Cell = { ...finalized, streaming: true };
    const f = (await frame(streaming))!;
    expect(f).toContain("deep inner monologue");
  });
});

describe("semantic stage views", () => {
  it("renders exploration as one compact tree with a stable heading", async () => {
    const stage = {
      actions: [
        { callId: "r1", kind: "read" as const, target: "README.md" },
        { callId: "g1", kind: "search" as const, target: "text_delta" },
      ],
    };
    const view = render(<ExplorationView stage={stage} />);
    await flush();
    expect(view.lastFrame()).toContain("• Explored\n  ├ Read README.md\n  └ Search text_delta");
  });

  it("renders a compact timed thought", async () => {
    const view = render(<ThoughtView thought={{ duration: 12_400 }} />);
    await flush();
    expect(view.lastFrame()).toContain("• Thought for 12s");
  });

  it("renders active and completed turn footers", async () => {
    const active = render(<WorkFooterView />);
    const complete = render(<WorkFooterView duration={12_400} />);
    await flush();
    expect(active.lastFrame()).toContain("Working…");
    expect(complete.lastFrame()).toContain("• Worked for 12s");
  });
});

describe("CellView: compaction", () => {
  const compaction: Cell = {
    kind: "compaction",
    id: "fold-1",
    text: "Summary of the work so far.",
  };

  it("compact: shows only the fold marker", async () => {
    const f = (await frame(compaction))!;
    expect(f).toContain("context compacted");
    expect(f).not.toContain("Summary of the work so far.");
  });

  it("verbose: shows the folded summary", async () => {
    const f = (await frame(compaction, true))!;
    expect(f).toContain("context compacted");
    expect(f).toContain("Summary of the work so far.");
  });
});

describe("CellView: edit cards", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.ts",
    ...Array.from({ length: 15 }, (_, index) => `+line-${index}`),
    "*** End Patch",
  ].join("\n");
  const edit: Extract<Cell, { kind: "tool" }> = {
    kind: "tool",
    callId: "patch-1",
    turnId: "t1",
    name: "apply_patch",
    args: patch,
    startedAt: 0,
    completedAt: 1,
    status: "ok",
    output: "updated a.ts",
  };

  it("shows a capped colored-patch shape in compact mode", async () => {
    const f = (await frame(edit))!;
    expect(f).toContain("Updated a.ts");
    expect(f).toContain("+line-0");
    expect(f).toContain("+line-11");
    expect(f).not.toContain("+line-14");
    expect(f).toContain("3 more lines");
    expect(f).not.toContain("updated a.ts\n");
  });

  it("shows the complete patch in verbose mode", async () => {
    const f = (await frame(edit, true))!;
    expect(f).toContain("+line-14");
    expect(f).not.toContain("more lines");
  });

  it("describes running and failed edits without claiming they landed", async () => {
    const runningEdit: Extract<Cell, { kind: "tool" }> = {
      kind: "tool",
      callId: edit.callId,
      ...(edit.turnId ? { turnId: edit.turnId } : {}),
      name: edit.name,
      args: edit.args,
      startedAt: edit.startedAt,
    };
    const running = (await frame(runningEdit))!;
    expect(running).toContain("Updating a.ts");
    expect(running).not.toContain("Updated a.ts");

    const failed = (await frame({ ...edit, status: "error", output: "patch rejected" }))!;
    expect(failed).toContain("Failed to update a.ts");
    expect(failed).toContain("attempted changes:");
    expect(failed).toContain("patch rejected");
  });

  it("keeps deleted file names visible in compact multi-file patches", async () => {
    const args = [
      "*** Begin Patch",
      "*** Update File: kept.ts",
      "@@",
      "-old",
      ...Array.from({ length: 15 }, (_, index) => `+line-${index}`),
      "*** Delete File: removed-a.ts",
      "*** Delete File: removed-b.ts",
      "*** End Patch",
    ].join("\n");
    const f = (await frame({ ...edit, args }))!;
    expect(f).toContain("removed-a.ts");
    expect(f).toContain("removed-b.ts");
    expect(f).toContain("7 more lines");
  });

  it("labels denied edits as failed requests rather than attempted mutations", async () => {
    const denied = (await frame({
      ...edit,
      status: "error",
      output: "denied",
      approval: { decision: "deny", responder: "human", relationship: "unknown" },
    }))!;
    expect(denied).toContain("Failed to update a.ts");
    expect(denied).toContain("requested changes:");
    expect(denied).not.toContain("attempted changes:");
    expect(denied).toContain("user denied");
  });

  it("falls back to the generic card for malformed patch input", async () => {
    const f = (await frame({ ...edit, args: "broken patch" }))!;
    expect(f).toContain("apply_patch");
    expect(f).toContain("broken patch");
  });
});
