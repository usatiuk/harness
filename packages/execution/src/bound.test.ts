import { describe, expect, it } from "vitest";
import {
  boundView,
  COMMAND_VIEW_DEFAULT_BYTES,
  COMMAND_VIEW_DEFAULT_LINES,
  COMMAND_VIEW_MAX_BYTES,
  COMMAND_VIEW_MAX_LINES,
  resolveCommandView,
} from "./bound.ts";

describe("boundView", () => {
  it("caps long lines byte-aware and selects the tail", () => {
    const out = boundView(`a\nb\n${"x".repeat(5000)}`, {
      maxLines: 2,
      maxLineBytes: 100,
      maxTotalBytes: 10_000,
      mode: "tail",
    });
    expect(out).toContain("…[+"); // the 5000-char line (kept in the tail) was capped
    expect(out).toContain("b"); // tail kept the last lines
    expect(out).not.toContain("x".repeat(200)); // never renders the full long line
  });

  it("applies a per-line filter", () => {
    const out = boundView("alpha\nbeta\ngamma", {
      maxLines: 10,
      maxLineBytes: 100,
      maxTotalBytes: 1000,
      mode: "head",
      filter: "a$",
    });
    expect(out).toBe(
      "alpha\nbeta\ngamma"
        .split("\n")
        .filter((l) => /a$/.test(l))
        .join("\n"),
    );
  });
});

describe("resolveCommandView", () => {
  it("defaults to the 40-line/16 KiB tail", () => {
    expect(resolveCommandView()).toEqual({
      maxLines: COMMAND_VIEW_DEFAULT_LINES,
      maxLineBytes: 1024,
      maxTotalBytes: COMMAND_VIEW_DEFAULT_BYTES,
      mode: "tail",
    });
    expect(COMMAND_VIEW_DEFAULT_LINES).toBe(40);
    expect(COMMAND_VIEW_DEFAULT_BYTES).toBe(16 * 1024);
  });

  it("widens the tail under the 500-line/64 KiB hard caps", () => {
    expect(resolveCommandView(200)).toMatchObject({ maxLines: 200, mode: "tail" });
    expect(resolveCommandView(200).maxTotalBytes).toBeLessThanOrEqual(COMMAND_VIEW_MAX_BYTES);
    expect(COMMAND_VIEW_MAX_LINES).toBe(500);
    expect(COMMAND_VIEW_MAX_BYTES).toBe(64 * 1024);
  });

  it("clamps over-cap requests instead of rendering unbounded output", () => {
    expect(resolveCommandView(10_000).maxLines).toBe(COMMAND_VIEW_MAX_LINES);
  });

  it.each([0, -3, 2.5, Number.NaN])("rejects a non-positive-integer max_lines=%s", (bad) => {
    expect(() => resolveCommandView(bad)).toThrow(/positive integer/);
  });
});
