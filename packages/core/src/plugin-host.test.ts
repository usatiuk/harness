import { describe, expect, it } from "vitest";
import type { Plugin, ToolMiddleware } from "@harness/protocol";
import { EchoTool, fakeCompaction, FakeProvider } from "@harness/testkit";
import { PluginHost } from "./plugin-host.ts";
import { noCompaction } from "./policies.ts";

const contributedCompaction = fakeCompaction({ over: 0 });

const passThrough = (id: string): ToolMiddleware => ({
  id,
  wrap: (call, _ctx, next) => next(call),
});

describe("PluginHost", () => {
  it("registers tools and providers, schemas sorted by name", () => {
    const host = new PluginHost([
      {
        id: "p",
        tools: () => [new EchoTool()],
        providers: () => [new FakeProvider([])],
      },
    ]);
    expect(host.tools.get("echo").name).toBe("echo");
    expect(host.providers.get("fake").provider).toBe("fake");
    expect(host.tools.schemas().map((s) => s.name)).toEqual(["echo"]);
  });

  it("falls back to noCompaction when none is contributed", () => {
    const host = new PluginHost([{ id: "p" }]);
    expect(host.policies.compaction).toBe(noCompaction);
  });

  it("uses a contributed compaction strategy in place of the default", () => {
    const host = new PluginHost([
      { id: "p", policies: () => ({ compaction: contributedCompaction }) },
    ]);
    expect(host.policies.compaction).toBe(contributedCompaction);
  });

  it("rejects two contributors for the compaction slot", () => {
    expect(
      () =>
        new PluginHost([
          { id: "a", policies: () => ({ compaction: contributedCompaction }) },
          { id: "b", policies: () => ({ compaction: contributedCompaction }) },
        ]),
    ).toThrow(/composition not yet supported/);
  });

  it("collects tool middleware in registration order, default truncate innermost", () => {
    const host = new PluginHost([
      { id: "p1", toolMiddleware: () => [passThrough("a")] },
      { id: "p2", toolMiddleware: () => [passThrough("b")] },
    ]);
    expect(host.toolMiddleware.map((m) => m.id)).toEqual(["a", "b", "truncate"]);
  });

  it("ships only the default truncate middleware when none is contributed", () => {
    const host = new PluginHost([{ id: "p" }]);
    expect(host.toolMiddleware.map((m) => m.id)).toEqual(["truncate"]);
  });

  it("rejects duplicate tool registration", () => {
    const plugin: Plugin = {
      id: "p",
      tools: () => [new EchoTool(), new EchoTool()],
    };
    expect(() => new PluginHost([plugin])).toThrow(/duplicate tool/);
  });
});
