import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Markdown } from "./markdown.tsx";
import { highlight } from "./markdown-highlight.ts";

const frame = (el: ReactElement): string => render(el).lastFrame() ?? "";

describe("Markdown", () => {
  it("renders headings and inline emphasis, consuming the markers", () => {
    const f = frame(<Markdown text={"# Title\n\nsome **bold** and *em* text\n"} />);
    expect(f).toContain("Title");
    expect(f).toContain("bold");
    expect(f).toContain("em");
    expect(f).not.toContain("**");
    expect(f).not.toContain("# Title");
  });

  it("renders nested and task lists", () => {
    const f = frame(<Markdown text={"- a\n  - nested\n- [x] done\n"} />);
    expect(f).toContain("nested");
    expect(f).toContain("[x] done");
    expect(f).toContain("•");
  });

  it("renders an ordered list with numeric markers", () => {
    const f = frame(<Markdown text={"1. one\n2. two\n"} />);
    expect(f).toContain("1. one");
    expect(f).toContain("2. two");
  });

  it("renders a GFM table with every cell and a rule", () => {
    const f = frame(<Markdown text={"| A | B |\n|---|---|\n| 1 | 2 |\n"} />);
    for (const s of ["A", "B", "1", "2"]) expect(f).toContain(s);
    expect(f).toContain("─");
  });

  it("renders inline code and links", () => {
    const f = frame(<Markdown text={"use `npm i` and see [docs](http://x)\n"} />);
    expect(f).toContain("npm i");
    expect(f).toContain("docs");
    expect(f).toContain("http://x");
  });

  it("renders code block content", () => {
    const f = frame(<Markdown text={"```ts\nconst x = 1;\n```\n"} />);
    expect(f).toContain("const x = 1;");
  });

  it("holds the partial trailing line raw while streaming (line-commit)", () => {
    const f = frame(<Markdown text={"committed line\n**partial"} streaming />);
    expect(f).toContain("committed line");
    // The half-typed inline marker is shown literally, not formatted away.
    expect(f).toContain("**partial");
  });

  it("formats fully-committed lines while streaming", () => {
    const f = frame(<Markdown text={"a line with **bold** done\n"} streaming />);
    expect(f).toContain("bold");
    expect(f).not.toContain("**");
  });

  it("renders empty text without crashing", () => {
    expect(frame(<Markdown text="" />)).toBeDefined();
  });
});

describe("highlight", () => {
  it("tokenizes known languages with colors", () => {
    const lines = highlight("const x = 1;", "ts");
    expect(lines).not.toBeNull();
    const flat = (lines ?? []).flat();
    expect(flat.map((t) => t.content).join("")).toContain("const");
    expect(flat.some((t) => typeof t.color === "string")).toBe(true);
  });

  it("returns null for unknown languages", () => {
    expect(highlight("whatever", "not-a-lang")).toBeNull();
  });

  it("returns null when no language is given", () => {
    expect(highlight("whatever", undefined)).toBeNull();
  });
});
