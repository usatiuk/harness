import { describe, expect, it } from "vitest";
import type { CommandContext } from "./commands.ts";
import { commands } from "./commands.ts";
import { complete, slashCompletion, type CompletionProvider } from "./completion.ts";

const models = [
  { provider: "openai", model: "gpt-5.1" },
  {
    provider: "anthropic",
    model: "claude-opus-4-8",
    presets: [{ value: "low" }, { value: "high" }],
  },
];

const ctx = {
  service: { availableModels: () => models },
  model: { provider: "anthropic", model: "claude-opus-4-8" },
} as unknown as CommandContext;

const values = (line: string): string[] =>
  slashCompletion.complete(line, line.length, ctx)?.items.map((i) => i.value) ?? [];

describe("slashCompletion — name stage", () => {
  it("lists every command for a bare slash", () => {
    const c = slashCompletion.complete("/", 1, ctx)!;
    expect(c.items).toHaveLength(commands.length);
    expect(c.range).toEqual([0, 1]);
  });

  it("filters by prefix and replaces the whole token", () => {
    const c = slashCompletion.complete("/mo", 3, ctx)!;
    expect(c.items.map((i) => i.value)).toEqual(["/model"]);
    expect(c.range).toEqual([0, 3]);
  });

  it("flags append-space only for commands that take arguments", () => {
    const items = slashCompletion.complete("/", 1, ctx)!.items;
    expect(items.find((i) => i.value === "/model")?.appendSpace).toBe(true);
    expect(items.find((i) => i.value === "/help")?.appendSpace).toBe(false);
  });

  it("returns null for non-slash input", () => {
    expect(slashCompletion.complete("hello", 5, ctx)).toBeNull();
  });

  it("returns null when the cursor is not at end of line", () => {
    expect(slashCompletion.complete("/model", 3, ctx)).toBeNull();
  });
});

describe("slashCompletion — argument stage", () => {
  it("offers model ids via the command's complete hook", () => {
    const c = slashCompletion.complete("/model ", 7, ctx)!;
    expect(c.items.map((i) => i.value)).toEqual(["openai/gpt-5.1", "anthropic/claude-opus-4-8"]);
    expect(c.range).toEqual([7, 7]);
  });

  it("substring-matches the typed partial and targets it", () => {
    const c = slashCompletion.complete("/model gpt", 10, ctx)!;
    expect(c.items.map((i) => i.value)).toEqual(["openai/gpt-5.1"]);
    expect(c.range).toEqual([7, 10]);
  });

  it("offers preset values for /preset", () => {
    expect(values("/preset ")).toEqual(["low", "high"]);
  });

  it("returns null for a command without a complete hook", () => {
    expect(slashCompletion.complete("/help x", 7, ctx)).toBeNull();
  });
});

describe("complete — provider engine", () => {
  const never: CompletionProvider = { complete: () => null };

  it("returns the first non-null provider result", () => {
    expect(complete([never, slashCompletion], "/mo", 3, ctx)?.items[0]?.value).toBe("/model");
  });

  it("returns null when no provider applies", () => {
    expect(complete([never], "/mo", 3, ctx)).toBeNull();
    expect(complete([], "/mo", 3, ctx)).toBeNull();
  });
});
