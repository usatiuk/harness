import { describe, expect, it } from "vitest";
import type { DeliveryPolicy, Plugin } from "@harness/protocol";
import { EchoTool, FakeProvider } from "@harness/testkit";
import { PluginHost } from "./plugin-host.ts";
import { allowAllToolGate, defaultDeliveryPolicy } from "./policies.ts";

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

  it("falls back to default policies when none are contributed", () => {
    const host = new PluginHost([{ id: "p" }]);
    expect(host.policies.toolGate).toBe(allowAllToolGate);
    expect(host.policies.delivery).toBe(defaultDeliveryPolicy);
  });

  it("uses a contributed policy in place of the default", () => {
    const delivery: DeliveryPolicy = { decide: () => "hold" };
    const host = new PluginHost([{ id: "p", policies: () => ({ delivery }) }]);
    expect(host.policies.delivery).toBe(delivery);
  });

  it("rejects duplicate tool registration", () => {
    const plugin: Plugin = {
      id: "p",
      tools: () => [new EchoTool(), new EchoTool()],
    };
    expect(() => new PluginHost([plugin])).toThrow(/duplicate tool/);
  });

  it("rejects two contributors for the same policy slot", () => {
    const delivery: DeliveryPolicy = { decide: () => "hold" };
    expect(
      () =>
        new PluginHost([
          { id: "a", policies: () => ({ delivery }) },
          { id: "b", policies: () => ({ delivery }) },
        ]),
    ).toThrow(/composition not yet supported/);
  });
});
