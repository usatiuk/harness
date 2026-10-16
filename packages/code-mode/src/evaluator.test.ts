import { describe, expect, it } from "vitest";
import { errorResult, okResult, textOf, type CodeToolBridge } from "@harness/protocol";
import { CODE_LIMITS, QuickJsEvaluator } from "./evaluator.ts";

const bridge: CodeToolBridge = {
  call: async (name, args) =>
    name === "fail"
      ? errorResult("denied")
      : { ...okResult("hidden"), structured: { name, args: args as string } },
};
const evaluate = (code: string) =>
  new QuickJsEvaluator().evaluate(code, bridge, new AbortController().signal);

describe("QuickJS evaluator", () => {
  it("supports async calls, selected returns, and explicit content emissions", async () => {
    const result = await evaluate(`
      const results = await Promise.all([tools.call("a", "one"), tools.call("b", "two")]);
      emitContent([{type: "text", text: "before"}]);
      return results.map(result => result.args);
    `);
    expect(result.status).toBe("ok");
    expect(textOf(result.forModel)).toBe('before["one","two"]');
  });
  it("preserves partial emissions and throws denied operations", async () => {
    const result = await evaluate(
      'emit("first"); await tools.call("fail", {}); return "unreachable";',
    );
    expect(result.status).toBe("error");
    expect(textOf(result.forModel)).toContain('"first"');
    expect(textOf(result.forModel)).toContain("denied");
  });
  it("allows deliberate error handling and exposes no ambient host APIs", async () => {
    const result = await evaluate(`try { await tools.call("fail", {}); } catch (error) {
      return [error.result.status, typeof process, typeof require, typeof fetch, typeof setTimeout];
    }`);
    expect(result.status).toBe("ok");
    expect(textOf(result.forModel)).toBe(
      '["error","undefined","undefined","undefined","undefined"]',
    );
  });
  it("bounds synchronous runaway computation and microtask loops", async () => {
    for (const code of ["while (true) {}", "while (true) { await Promise.resolve(); }"]) {
      const result = await evaluate(code);
      expect(result.status).toBe("error");
      expect(textOf(result.forModel)).toMatch(/interrupt|computation/);
    }
  });
  it("settles host replies while the guest continuously schedules microtasks", async () => {
    const result = await evaluate(`
      let settled = false;
      const reply = tools.call("a", "reply").then(value => {
        settled = true;
        return value;
      });
      while (!settled) await Promise.resolve();
      return await reply;
    `);
    expect(result.status).toBe("ok");
    expect(textOf(result.forModel)).toBe('{"name":"a","args":"reply"}');
  });
  it.each([
    // A retained allocation at the limit exceeds the heap's remaining capacity.
    // Filling giant arrays instead can hit computation limits before memory.
    ["memory", `return new ArrayBuffer(${CODE_LIMITS.memoryBytes});`, "out of memory"],
    ["output", 'return "x".repeat(100000);', "output limit"],
    ["unresolved promises", "await new Promise(() => {});", "no host operation"],
    [
      "submissions",
      'await Promise.all(Array.from({length: 30}, () => tools.call("a", {})));',
      "submission limit",
    ],
  ])("bounds %s", async (_boundary, code, message) => {
    const result = await evaluate(code);
    expect(result.status).toBe("error");
    expect(textOf(result.forModel)).toContain(message);
  });
  it("cancels while awaiting a host promise", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = new QuickJsEvaluator().evaluate(
      'await tools.call("hold", {});',
      {
        ...bridge,
        call: async () => {
          started();
          return new Promise(() => {});
        },
      },
      controller.signal,
    );
    await invoked;
    controller.abort();
    expect((await result).status).toBe("error");
  });
  it("applies computation limits to error serialization and property getters", async () => {
    for (const code of [
      "throw {toJSON() {while (true) {}}};",
      "throw {get message() {while (true) {}}};",
      'Object.defineProperty(JSON, "stringify", {get() {while (true) {}}}); return 1;',
    ]) {
      const result = await evaluate(code);
      expect(result.status).toBe("error");
      expect(textOf(result.forModel)).toMatch(/interrupt|computation/);
    }
  });
  it.each([
    ["arguments", 'await tools.call("a", "x".repeat(1100000));'],
    ["names", 'await tools.call("x".repeat(1100000), {});'],
    ["total submissions", 'for (let i=0; i<129; i++) await tools.call("a", {});'],
    ["aggregate transfer", 'for (let i=0; i<12; i++) await tools.call("a", "x".repeat(400000));'],
  ])("bounds %s and preserves partial output", async (_boundary, code) => {
    const result = await evaluate(`emit("before"); ${code}`);
    expect(result.status).toBe("error");
    expect(textOf(result.forModel)).toContain('"before"');
    expect(textOf(result.forModel)).toMatch(/limit/);
  });
  it("bounds structured tool results", async () => {
    const result = await new QuickJsEvaluator().evaluate(
      'await tools.call("huge", {});',
      {
        ...bridge,
        call: async () => ({ ...okResult("small"), structured: "x".repeat(1100000) }),
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("error");
    expect(textOf(result.forModel)).toContain("data limit");
  });
  it("exposes tool calls without guest discovery APIs", async () => {
    const result = await evaluate(
      "return [typeof tools.search, typeof tools.describe, Object.keys(tools), typeof __call, typeof __emit];",
    );
    expect(textOf(result.forModel)).toBe(
      '["undefined","undefined",["call"],"undefined","undefined"]',
    );
  });
  it("rejects unsupported content blocks explicitly", async () => {
    const result = await evaluate('emitContent([{type:"image", data:"unsupported"}]);');
    expect(result.status).toBe("error");
  });
  it("keeps empty-message failures as errors", async () => {
    for (const code of ['throw new Error("");', 'throw "";']) {
      const result = await evaluate(code);
      expect(result.status).toBe("error");
      expect(textOf(result.forModel)).toBe("code execution failed");
    }
  });
  it("bounds hostile thenables during bridged promise settlement", async () => {
    const result = await evaluate(
      'Object.defineProperty(Object.prototype, "then", {get() {while (true) {}}}); await tools.call("a", {});',
    );
    expect(result.status).toBe("error");
    expect(textOf(result.forModel)).toMatch(/interrupt|computation/);
  });
});
