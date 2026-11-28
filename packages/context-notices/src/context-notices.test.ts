import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  textOf,
  type AgentRequestContext,
  type Item,
  type PluginContextItem,
} from "@harness/protocol";
import { contextNoticesPlugin as plugin } from "./index.ts";

const model = { provider: "fixture", model: "first" };
function windowHarness(items: Item[] = []) {
  const ctx = { active: async () => items, service: () => undefined };
  const append = (out: PluginContextItem[]) => {
    for (const entry of out) {
      if (entry.data !== undefined)
        items.push({ type: "plugin_data", plugin: plugin.id, data: entry.data } as Item);
    }
    return textOf(out.flatMap((entry) => (entry.type === "context" ? entry.content : [])));
  };
  return {
    open: () => {
      const { content, data } = plugin.systemContext(model);
      append([{ type: "plugin_data", data }]);
      return textOf(content);
    },
    request: async (input: AgentRequestContext = { model }) =>
      append(await plugin.contextItems(ctx, { type: "agentRequest", ...input })),
    fork: () => windowHarness([...items]),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-11-27T12:00:00Z");
  vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("seeds the opening snapshot and advances clock and model independently", async () => {
  const window = windowHarness();
  const opening = window.open();
  expect(opening).toContain("fixture/first");
  expect(opening).toContain("2026-11-27 12:00 UTC+00:00");
  vi.setSystemTime("2026-11-27T12:09:59.999Z");
  expect(await window.request()).toBe("");
  const switched = { model: { provider: "other", model: model.model } };
  const change = await window.request(switched);
  expect(change).toContain("other/first");
  expect(change).not.toContain("2026-11-27");
  vi.setSystemTime("2026-11-27T12:10:00Z");
  const clock = await window.request(switched);
  expect(clock).toContain("12:10 UTC+00:00");
  expect(clock).not.toContain("2026-11-27");
  expect(clock).not.toContain("other/first");
  expect(await window.request(switched)).toBe("");
  const modelOnly = await window.request({ model: { provider: "other", model: "second" } });
  expect(modelOnly).toContain("other/second");
  expect(modelOnly).not.toContain("12:10");
});

it("reconciles a local midnight and a timezone change without waiting ten minutes", async () => {
  const zone = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-345);
  vi.setSystemTime("2026-11-27T18:14:59Z");
  const window = windowHarness();
  expect(window.open()).toContain("2026-11-27 23:59 UTC+05:45");
  vi.setSystemTime("2026-11-27T18:15:00Z");
  expect(await window.request()).toContain("2026-11-28 00:00 UTC+05:45");
  zone.mockReturnValue(-330);
  expect(await window.request()).toContain("2026-11-27 23:45 UTC+05:30");
  zone.mockReturnValue(210);
  expect(await window.request()).toContain("2026-11-27 14:45 UTC-03:30");
});

it("warns once per active window, independent of later updates or abandoned branches", async () => {
  const window = windowHarness();
  window.open();
  const usage = (estimatedTokens: number) => ({
    model,
    capacity: { estimatedTokens, thresholdTokens: 1000 },
  });
  expect(await window.request()).toBe(""); // unknown threshold or folding already due
  expect(await window.request(usage(899))).toBe("");
  const sibling = window.fork();
  expect(await window.request(usage(900))).toContain("90%");
  vi.setSystemTime("2026-11-27T12:11:00Z");
  expect(await window.request(usage(955))).not.toContain("%");
  expect(await window.request(usage(979))).toBe("");
  expect(await sibling.request(usage(950))).toContain("95%");
  const fresh = windowHarness();
  expect(fresh.open()).toContain("12:11");
  expect(await fresh.request(usage(980))).toContain("98%");
});
