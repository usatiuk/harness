import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { MemorySecretStore } from "@harness/secrets";
import { HarnessService } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, toolStep, textStep } from "@harness/testkit";
import { createApprovalPlugin } from "@harness/approval";
import { autoApprovalPlugin } from "@harness/auto-approval";
import { QuickJsEvaluator } from "@harness/code-mode";
import {
  isKernelEvent,
  textOf,
  type Item,
  type ToolMode,
  type ModelRequest,
} from "@harness/protocol";
import { McpRuntime, mcpConfigSchema } from "./index.ts";
import { fixtureSchema, httpFixture } from "./testing-fixture.ts";
import { scopedSecrets } from "./credentials.ts";

async function execute(
  runtime: McpRuntime,
  rawName: string,
  args: unknown,
  mode: ToolMode = "direct",
  config: Record<string, unknown> = {},
  options: {
    human?: "allow" | "deny";
    scoped?: boolean;
    allow?: string[];
    interruptWhen?: Promise<void>;
    auto?: boolean;
    requests?: ModelRequest[];
  } = {},
) {
  const name = runtime.tools().find((tool) => tool.rawName === rawName)!.name;
  const provider = new FakeProvider([
    toolStep(
      "call",
      mode === "direct" ? name : "eval",
      mode === "direct"
        ? args
        : { code: `return await tools.call(${JSON.stringify(name)}, ${JSON.stringify(args)});` },
    ),
    ...(options.auto ? [textStep("YES")] : []),
    textStep("done"),
  ]);
  const store = new InMemoryStore();
  const service = new HarnessService({
    store,
    home: "/nonexistent-mcp-test-home",
    codeEvaluator: new QuickJsEvaluator(),
    defaults: {
      model: { provider: "fake", model: "fake-1" },
      tools: { mode },
      plugins: { approval: { humanApprovalTimeoutSeconds: 0.02, ...config } },
    },
    plugins: [
      {
        id: "fake",
        providers: () => [
          {
            provider: provider.provider,
            capabilities: () => provider.capabilities(),
            validateConfig: () => {},
            listModels: () => provider.listModels(),
            stream: (request) => {
              options.requests?.push(request);
              return provider.stream();
            },
          },
        ],
      },
      createApprovalPlugin((name) => !runtime.ownsTool(name)),
      runtime.plugin(),
      ...(options.auto ? [autoApprovalPlugin] : []),
    ],
  });
  const parent = options.scoped ? await service.createConversation() : undefined;
  if (parent) await service.prepare(parent.id);
  const conversation = await service.createConversation(
    parent
      ? {
          parentId: parent.id,
          overrides: {
            tools: {
              allow: options.allow ?? [
                runtime.tools().find((t) => t.rawName === "echo/with spaces")!.name,
              ],
            },
          },
        }
      : options.auto
        ? { overrides: { plugins: { "auto-approval": { enabled: true } } } }
        : {},
  );
  if (options.human)
    service.subscribe((event) => {
      if (isKernelEvent(event) && event.type === "request.created")
        service.respond(event.conversationId, event.requestId, { decision: options.human });
    });
  try {
    await service.deliver(conversation.id, "run", "send");
    if (options.interruptWhen) {
      await options.interruptWhen;
      await service.deliver(conversation.id, "", "interrupt");
    }
    await service.whenIdle(conversation.id);
    return await service.getItems(conversation.id);
  } finally {
    await service.deactivateSession(conversation.id, { force: true });
    if (parent) await service.deactivateSession(parent.id, { force: true });
  }
}
const result = (items: Item[]) =>
  items.find(
    (item): item is Extract<Item, { type: "tool_result" }> =>
      item.type === "tool_result" && !item.parentCallId,
  );

it("discovers a real stdio process with host env/secret sources, preserves JSON Schema, executes through direct and code mode, and closes", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mcp-stdio-")));
  const config = mcpConfigSchema.parse({
    servers: {
      local: {
        transport: {
          type: "stdio",
          executable: process.execPath,
          args: [
            "--import",
            pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
            fileURLToPath(new URL("./stdio-fixture.ts", import.meta.url)),
          ],
          cwd,
          env: { FIXTURE_SECRET: { type: "secret", slot: "key" } },
        },
      },
    },
  });
  const secrets = new MemorySecretStore();
  const runtime = new McpRuntime(config, secrets);
  try {
    await runtime.setCredential("local", config.servers["local"]!, "key", "secret-value");
    await runtime.initialize();
    expect((await runtime.statuses())[0]).toMatchObject({
      status: "ready",
      toolCount: 2,
      credentials: [{ slot: "key", present: true }],
    });
    const tool = runtime.plugin().create({ get: async <C>() => ({}) as C }).tools!(
      new FakeProvider([]).capabilities(),
      { service: () => undefined },
    )[0]!;
    expect(tool.input).toMatchObject({ kind: "json-schema", schema: fixtureSchema });
    expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
    const source = runtime.plugin().create({ get: async <C>() => ({}) as C }).contextSources!()[0]!;
    expect(await source.instructions({ service: () => undefined, toolNames: [] })).toEqual([]);
    expect(
      textOf(await source.instructions({ service: () => undefined, toolNames: [tool.name] })),
    ).toContain("Available MCP servers: local");
    for (const mode of ["direct", "code-only"] as const) {
      const requests: ModelRequest[] = [];
      const items = await execute(
        runtime,
        "echo/with spaces",
        { value: "accepted" },
        mode,
        {},
        { requests },
      );
      expect(textOf(requests[0]!.instructions)).toContain("Available MCP servers: local");
      expect(items.filter((item) => item.type === "tool_result")).toContainEqual(
        expect.objectContaining({
          status: "ok",
          structured: { value: "accepted", env: "secret-value", cwd },
        }),
      );
    }
    expect(
      result(await execute(runtime, "echo/with spaces", { value: "forbidden" })),
    ).toMatchObject({ status: "error" });
    expect(
      result(await execute(runtime, "echo/with spaces", { value: "yes", mode: "image" })),
    ).toMatchObject({
      status: "error",
      content: [{ type: "text", text: "MCP returned unsupported content" }],
    });
    expect(
      result(
        await execute(runtime, "echo/with spaces", { value: "remote failure", mode: "error" }),
      ),
    ).toMatchObject({ status: "error" });
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("forwards cancellation and fails an uncertain disconnected operation without replay", async () => {
  for (const disconnect of [false, true]) {
    let entered!: () => void, cancelled!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const fixture = await httpFixture({
      hold: async (signal) => {
        entered();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled();
              resolve();
            },
            { once: true },
          );
          if (signal.aborted) {
            cancelled();
            resolve();
          }
        });
      },
    });
    const runtime = new McpRuntime(
      { servers: { s: { transport: { type: "http", url: fixture.url } } } },
      new MemorySecretStore(),
    );
    try {
      await runtime.initialize();
      const running = execute(
        runtime,
        "echo/with spaces",
        { value: "once", mode: "hold" },
        "direct",
        {},
        disconnect ? {} : { interruptWhen: started },
      );
      await started;
      if (disconnect) await fixture.close();
      const items = await running;
      expect(result(items)).toMatchObject({ status: "error" });
      expect(fixture.calls).toEqual([{ value: "once", mode: "hold" }]);
      await aborted;
    } finally {
      await runtime.close();
      if (!disconnect) await fixture.close();
    }
  }
});

it("resolves global/server/exact-tool policies through direct and code calls, including scoped children", async () => {
  const fixture = await httpFixture();
  const configurations = [
    { defaults: { readOnly: "deny", other: "deny" }, expected: "error" },
    { defaults: { other: "deny" }, server: { defaults: { other: "allow" } }, expected: "ok" },
    { server: { defaults: { other: "deny" }, tools: { mutate: "allow" } }, expected: "ok" },
    { server: { tools: { mutate: "ask" } }, human: "allow", expected: "ok" },
    { server: { tools: { mutate: "ask-human" } }, human: "deny", expected: "error" },
  ] as const;
  try {
    for (const test of configurations) {
      const runtime = new McpRuntime(
        {
          ...("defaults" in test ? { defaults: test.defaults } : {}),
          servers: {
            s: {
              transport: { type: "http", url: fixture.url },
              ...("server" in test ? test.server : {}),
            },
          },
        },
        new MemorySecretStore(),
      );
      try {
        await runtime.initialize();
        const before = fixture.calls.length;
        for (const mode of ["direct", "code-only"] as const) {
          const items = await execute(
            runtime,
            "mutate",
            { value: "policy" },
            mode,
            {},
            "human" in test ? { human: test.human } : {},
          );
          expect(result(items)?.status).toBe(test.expected);
        }
        expect(fixture.calls.length - before).toBe(test.expected === "ok" ? 2 : 0);
        const scopedRequests: ModelRequest[] = [];
        expect(
          result(
            await execute(
              runtime,
              "mutate",
              { value: "withheld" },
              "code-only",
              {},
              { scoped: true, requests: scopedRequests },
            ),
          ),
        ).toMatchObject({ status: "error" });
        expect(textOf(scopedRequests[0]!.instructions)).toContain("Available MCP servers: s");
        expect(
          scopedRequests[0]!.tools!.find((tool) => tool.name === "eval")!.description,
        ).not.toContain(runtime.tools().find((tool) => tool.rawName === "mutate")!.name);
        const emptyScope: ModelRequest[] = [];
        expect(
          result(
            await execute(
              runtime,
              "mutate",
              { value: "withheld" },
              "code-only",
              {},
              { scoped: true, allow: [], requests: emptyScope },
            ),
          )?.status,
        ).toBe("error");
        expect(textOf(emptyScope[0]!.instructions)).not.toContain("Available MCP servers:");
        expect(fixture.calls.length - before).toBe(test.expected === "ok" ? 2 : 0);
      } finally {
        await runtime.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

it("uses real HTTP with target-bound header credentials, exact tool rules and one shared human denial", async () => {
  const fixture = await httpFixture();
  const config = mcpConfigSchema.parse({
    servers: {
      hosted: {
        transport: {
          type: "http",
          url: fixture.url,
          headers: { "X-Secret": { type: "secret", slot: "header" } },
          auth: { type: "bearer", token: { type: "env", name: "TOKEN" } },
        },
        tools: { mutate: "ask-human" },
      },
    },
  });
  const secrets = new MemorySecretStore();
  const runtime = new McpRuntime(config, secrets, { TOKEN: "bearer-value" });
  try {
    await runtime.setCredential("hosted", config.servers["hosted"]!, "header", "header-value");
    await runtime.initialize();
    expect(runtime.tools()).toHaveLength(2);
    const items = await execute(runtime, "mutate", { value: "denied" });
    expect(result(items)).toMatchObject({
      status: "error",
      annotations: {
        approval: { decision: "deny", responder: "human", reason: "human approval timed out" },
      },
    });
    expect(fixture.calls).toEqual([]);
    await execute(runtime, "echo/with spaces", { value: "allowed" });
    expect(fixture.calls).toEqual([{ value: "allowed" }]);
    expect(
      fixture.requests
        .filter((r) => r.url === "/mcp")
        .every((r) => r.custom === "header-value" && r.authorization === "Bearer bearer-value"),
    ).toBe(true);
    const changed = structuredClone(config.servers["hosted"]!);
    if (changed.transport.type !== "http") throw new Error("expected HTTP");
    changed.transport.url += "?changed";
    expect(await runtime.test("hosted", changed)).toMatchObject({ status: "auth-required" });
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

it("isolates an unavailable server and never hot-reloads the startup catalog during Test", async () => {
  const fixture = await httpFixture();
  const runtime = new McpRuntime(
    {
      servers: {
        missing: { transport: { type: "stdio", executable: "/nonexistent-mcp-command" } },
        good: { transport: { type: "http", url: fixture.url } },
        disabled: {
          enabled: false,
          transport: { type: "stdio", executable: "/nonexistent-mcp-command" },
        },
      },
    },
    new MemorySecretStore(),
  );
  try {
    await runtime.initialize();
    expect((await runtime.statuses()).map((s) => s.status)).toEqual([
      "unavailable",
      "ready",
      "disabled",
    ]);
    const catalog = runtime.tools();
    expect(
      await runtime.test(
        "extra",
        mcpConfigSchema.parse({
          servers: { extra: { transport: { type: "http", url: fixture.url } } },
        }).servers["extra"]!,
      ),
    ).toMatchObject({ status: "ready" });
    expect(runtime.tools()).toEqual(catalog);
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

it("rejects invalid transport headers, credential layouts and nonpositive timeout settings at the boundary", () => {
  for (const transport of [
    { type: "http", url: "http://example.com" },
    {
      type: "http",
      url: "https://example.com",
      headers: { "MCP-Protocol-Version": { type: "literal", value: "x" } },
    },
    {
      type: "http",
      url: "https://example.com",
      auth: { type: "oauth", clientSecret: { type: "secret", slot: "x" } },
    },
    {
      type: "http",
      url: "https://example.com",
      auth: { type: "oauth", clientMetadataUrl: "http://localhost/client.json" },
    },
  ]) {
    expect(mcpConfigSchema.safeParse({ servers: { bad: { transport } } }).success).toBe(false);
  }
});

it("rejects reserved dictionary keys before parsing can silently discard them", () => {
  const server = { transport: { type: "stdio", executable: "node" } };
  const reserved = JSON.parse('{"__proto__":"deny"}') as unknown;
  const source = JSON.parse('{"__proto__":{"type":"literal","value":"x"}}') as unknown;
  for (const config of [
    { servers: JSON.parse(`{"__proto__":${JSON.stringify(server)}}`) as unknown },
    { servers: { local: { ...server, tools: reserved } } },
    { servers: { local: { transport: { ...server.transport, env: source } } } },
    {
      servers: {
        hosted: { transport: { type: "http", url: "https://example.com/mcp", headers: source } },
      },
    },
  ])
    expect(mcpConfigSchema.safeParse(config).success).toBe(false);
});

it("discovers paginated catalogs and rejects a server's duplicate names or invalid schemas atomically", async () => {
  for (const failure of [undefined, "duplicate", "schema"] as const) {
    const fixture = await httpFixture({
      catalog: (cursor) =>
        cursor
          ? {
              tools: [
                {
                  name: failure === "duplicate" ? "first" : "second",
                  inputSchema:
                    failure === "schema"
                      ? { type: "object", properties: { bad: { type: "invalid" } } }
                      : fixtureSchema,
                },
              ],
            }
          : { tools: [{ name: "first", inputSchema: fixtureSchema }], nextCursor: "second-page" },
    });
    const runtime = new McpRuntime(
      { servers: { paged: { transport: { type: "http", url: fixture.url } } } },
      new MemorySecretStore(),
    );
    try {
      await runtime.initialize();
      expect((await runtime.statuses())[0]).toMatchObject({
        status: failure ? "unavailable" : "ready",
        toolCount: failure ? 0 : 2,
      });
      expect(runtime.tools().map((t) => t.rawName)).toEqual(failure ? [] : ["first", "second"]);
    } finally {
      await runtime.close();
      await fixture.close();
    }
  }
});

it("isolates corrupted stored credentials without exposing their contents", async () => {
  const fixture = await httpFixture(),
    secrets = new MemorySecretStore();
  await scopedSecrets(secrets, "bad", "credential").set("header", "broken private value");
  const runtime = new McpRuntime(
    {
      servers: {
        bad: {
          transport: {
            type: "http",
            url: fixture.url,
            headers: { "X-Key": { type: "secret", slot: "header" } },
          },
        },
        good: { transport: { type: "http", url: fixture.url } },
      },
    },
    secrets,
  );
  try {
    await runtime.initialize();
    expect((await runtime.statuses()).map((s) => s.status)).toEqual(["auth-required", "ready"]);
    expect(JSON.stringify(await runtime.statuses())).not.toContain("broken private value");
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

it("does not forward resource credentials through a redirect", async () => {
  const destination = await httpFixture();
  const source = await httpFixture({
    before: (request, response) => {
      if (request.url !== "/mcp") return false;
      response.writeHead(307, { Location: destination.url }).end();
      return true;
    },
  });
  const runtime = new McpRuntime(
    {
      servers: {
        s: {
          transport: {
            type: "http",
            url: source.url,
            headers: { "X-Secret": { type: "literal", value: "resource-only" } },
            auth: { type: "bearer", token: { type: "env", name: "TOKEN" } },
          },
        },
      },
    },
    new MemorySecretStore(),
    { TOKEN: "bearer-private" },
  );
  try {
    await runtime.initialize();
    expect((await runtime.statuses())[0]).toMatchObject({ status: "unavailable" });
    expect(source.requests[0]).toMatchObject({
      custom: "resource-only",
      authorization: "Bearer bearer-private",
    });
    expect(destination.requests).toEqual([]);
  } finally {
    await runtime.close();
    await source.close();
    await destination.close();
  }
});

it("routes ordinary MCP Ask through existing auto-review and keeps Ask human human-only", async () => {
  const fixture = await httpFixture();
  try {
    for (const permission of ["ask", "ask-human"] as const) {
      const runtime = new McpRuntime(
        {
          servers: {
            s: { transport: { type: "http", url: fixture.url }, tools: { mutate: permission } },
          },
        },
        new MemorySecretStore(),
      );
      try {
        await runtime.initialize();
        const items = await execute(
          runtime,
          "mutate",
          { value: permission },
          "code-only",
          {},
          { auto: true },
        );
        const governed = items.find((i) => i.type === "tool_result" && !!i.parentCallId);
        expect(governed).toMatchObject({
          status: permission === "ask" ? "ok" : "error",
          annotations: {
            approval: {
              decision: permission === "ask" ? "allow" : "deny",
              responder: permission === "ask" ? "auto" : "human",
            },
          },
        });
      } finally {
        await runtime.close();
      }
    }
    expect(fixture.calls).toEqual([{ value: "ask" }]);
  } finally {
    await fixture.close();
  }
});

it("uses only explicit tool overrides, including prototype-named MCP tools", async () => {
  const fixture = await httpFixture({
    catalog: () => ({ tools: [{ name: "toString", inputSchema: fixtureSchema }] }),
  });
  const runtime = new McpRuntime(
    {
      defaults: { other: "deny" },
      servers: { s: { transport: { type: "http", url: fixture.url } } },
    },
    new MemorySecretStore(),
  );
  try {
    await runtime.initialize();
    expect(result(await execute(runtime, "toString", { value: "denied" }))).toMatchObject({
      status: "error",
      annotations: { approval: { decision: "deny", responder: "policy" } },
    });
    expect(fixture.calls).toEqual([]);
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

it("keeps stored bearer replacement inactive until reconnect/restart", async () => {
  const fixture = await httpFixture();
  const config = mcpConfigSchema.parse({
    servers: {
      s: {
        transport: {
          type: "http",
          url: fixture.url,
          auth: { type: "bearer", token: { type: "secret", slot: "token" } },
        },
      },
    },
  });
  const runtime = new McpRuntime(config, new MemorySecretStore());
  try {
    await runtime.setCredential("s", config.servers["s"]!, "token", "original");
    await runtime.initialize();
    await runtime.setCredential("s", config.servers["s"]!, "token", "replacement");
    await execute(runtime, "echo/with spaces", { value: "same active snapshot" });
    expect(fixture.requests.at(-1)?.authorization).toBe("Bearer original");
    expect(await runtime.test("s", config.servers["s"]!)).toMatchObject({ status: "ready" });
    expect(fixture.requests.at(-1)?.authorization).toBe("Bearer replacement");
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

it("isolates secret-backend failure and reports safe status while other servers remain usable", async () => {
  const fixture = await httpFixture();
  const store = new MemorySecretStore();
  store.get = async () => {
    throw Error("private backend diagnostics");
  };
  const runtime = new McpRuntime(
    {
      servers: {
        bad: {
          transport: {
            type: "http",
            url: fixture.url,
            auth: { type: "bearer", token: { type: "secret", slot: "token" } },
          },
        },
        oauth: { transport: { type: "http", url: fixture.url, auth: { type: "oauth" } } },
        good: { transport: { type: "http", url: fixture.url } },
      },
    },
    store,
  );
  try {
    await runtime.initialize();
    const statuses = await runtime.statuses();
    expect(statuses.map((s) => s.status)).toEqual(["unavailable", "unavailable", "ready"]);
    expect(statuses[0]?.detail).toBe("MCP credential store unavailable");
    expect(JSON.stringify(statuses)).not.toContain("private backend diagnostics");
    for (const id of ["bad", "oauth"]) {
      const status = await runtime.test(id, runtime.config.servers[id]!);
      expect(status).toMatchObject({
        status: "unavailable",
        detail: "MCP credential store unavailable",
      });
      expect(JSON.stringify(status)).not.toContain("private backend diagnostics");
    }
  } finally {
    await runtime.close();
    await fixture.close();
  }
});
