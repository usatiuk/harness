import { describe, expect, it } from "vitest";
import { boundView } from "./bound.ts";

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
