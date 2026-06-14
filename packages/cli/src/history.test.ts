import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addEntry, loadHistory, saveHistory } from "./history.ts";

const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "hist-")), "history.jsonl");

describe("addEntry", () => {
  it("appends as newest", () => {
    expect(addEntry(["a"], "b")).toEqual(["a", "b"]);
  });

  it("moves a repeat to the end instead of duplicating", () => {
    expect(addEntry(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it("ignores blank lines", () => {
    expect(addEntry(["a"], "   ")).toEqual(["a"]);
  });

  it("caps to the most recent entries", () => {
    const many = Array.from({ length: 200 }, (_, i) => `e${i}`);
    const out = addEntry(many, "new");
    expect(out).toHaveLength(200);
    expect(out[0]).toBe("e1");
    expect(out.at(-1)).toBe("new");
  });
});

describe("load/save round trip", () => {
  it("persists and reloads entries, oldest-first", () => {
    const path = tmpFile();
    saveHistory(["one", "two"], path);
    expect(loadHistory(path)).toEqual(["one", "two"]);
  });

  it("survives embedded newlines via JSON encoding", () => {
    const path = tmpFile();
    saveHistory(["line\nwith\nbreaks"], path);
    expect(loadHistory(path)).toEqual(["line\nwith\nbreaks"]);
  });

  it("returns empty for a missing file", () => {
    expect(loadHistory(join(tmpdir(), "does-not-exist-xyz.jsonl"))).toEqual([]);
  });

  it("skips malformed lines but keeps valid ones", () => {
    const path = tmpFile();
    writeFileSync(path, '"good"\nnot json\n"also good"\n');
    expect(loadHistory(path)).toEqual(["good", "also good"]);
  });
});
