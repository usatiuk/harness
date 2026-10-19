import { afterEach, expect, it, vi } from "vitest";
import type { ModelRequest, ModelStreamEvent, ToolSchema } from "@harness/protocol";
import { DemoProvider } from "./demo-provider.ts";

const tool = (name: string): ToolSchema => ({
  kind: "function",
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});
afterEach(() => vi.useRealTimers());

async function events(tools: string[]) {
  vi.useFakeTimers();
  const request: ModelRequest = {
    instructions: [],
    items: [],
    tools: tools.map(tool),
    modelConfig: { provider: "demo", model: "demo-1" },
  };
  const pending = (async () => {
    const result: ModelStreamEvent[] = [];
    for await (const event of new DemoProvider().stream(request, new AbortController().signal))
      result.push(event);
    return result;
  })();
  await vi.runAllTimersAsync();
  return pending;
}

it.each(["bash", "zsh", "powershell"])(
  "uses the offered %s command language directly",
  async (shell) => {
    expect(await events([shell])).toContainEqual(
      expect.objectContaining({ type: "tool_call", name: shell }),
    );
  },
);

it.each(["bash", "zsh", "powershell"])(
  "uses the offered %s command language through code mode",
  async (shell) => {
    const call = (await events(["eval", shell])).find((event) => event.type === "tool_call");
    expect(call).toHaveProperty("name", "eval");
    expect(call).toHaveProperty("args.code", expect.stringContaining(`tools.call("${shell}"`));
  },
);

it("includes zsh when discovering a command tool", async () => {
  const call = (await events(["eval", "tool_search"])).find((event) => event.type === "tool_call");
  expect(call).toHaveProperty("name", "tool_search");
  expect(call).toHaveProperty("args.queries", expect.arrayContaining(["zsh"]));
});
