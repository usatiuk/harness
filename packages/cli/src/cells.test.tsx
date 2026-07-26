import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { Cell } from "./transcript-reducer.ts";
import { CellView, toolSummary, VerboseContext } from "./cells.tsx";

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
  const okTool: Cell = {
    kind: "tool",
    callId: "k1",
    name: "bash",
    args: { command: "npm test" },
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
      name: "bash",
      args: { command: "ls" },
    };
    const f = (await frame(running))!;
    expect(f).toContain("ls");
    expect(f).not.toContain("done");
  });
});

describe("CellView: reasoning", () => {
  const finalized: Cell = {
    kind: "reasoning",
    turnId: "t1",
    text: "deep inner monologue here",
    streaming: false,
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
