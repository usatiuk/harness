import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  isKernelEvent,
  okResult,
  textOf,
  type HarnessEvent,
  type Item,
  type ModelProvider,
  type ModelRequest,
  type Tool,
  type ToolMode,
  type ConversationId,
  type Store,
  type Plugin,
  type CompactionStrategy,
  type ToolContract,
  type CustomToolInput,
  type ModelCapabilities,
} from "@harness/protocol";
import { HarnessClient, createInProcessMessageConnectionPair, decodeItem } from "@harness/client";
import { SqliteStore } from "@harness/store-sqlite";
import { buildResponseParams, buildChatParams } from "@harness/openai-core";
import { buildMessages } from "@harness/anthropic-core";
import { reconcileConversation, modelCompaction } from "@harness/core";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, textStep, toolStep, type FakeStep } from "@harness/testkit";
import {
  localExecutionPlugin,
  LocalExecutionContext,
  executionFunctionTool,
  executionOf,
  executionEscalationOf,
} from "@harness/execution";
import { activitiesPlugin } from "@harness/activities";
import { workspacePlugin } from "@harness/workspace";
import { agentsPlugin } from "@harness/agents";
import { approvalPlugin, isApprovalRequest } from "@harness/approval";
import { autoApprovalPlugin } from "@harness/auto-approval";
import { outputPlugin } from "@harness/output";
import { SubagentsDefinition } from "@harness/subagents";
import { QuickJsEvaluator } from "@harness/code-mode";
import { HarnessService } from "./service.ts";
import { HarnessRpcSession } from "./rpc-session.ts";
import { HarnessRpcHost } from "./rpc-host.ts";

const roots: string[] = [];
const sessions: { svc: HarnessService; id: ConversationId }[] = [];
afterEach(async () => {
  for (const { svc, id } of sessions.splice(0)) await svc.deactivateSession(id, { force: true });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const results = (items: Item[]) =>
  items.filter(
    (item): item is Extract<Item, { type: "tool_result" }> => item.type === "tool_result",
  );
const calls = (items: Item[]) =>
  items.filter((item): item is Extract<Item, { type: "tool_call" }> => item.type === "tool_call");
const evalStep = (code: string) => toolStep("outer", "eval", { code });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  steps: FakeStep[],
  tools: Tool[] = [],
  mode: ToolMode = "code-only",
  pluginConfig: Record<string, unknown> = {},
  options: {
    store?: Store;
    execution?: Plugin | null;
    compaction?: CompactionStrategy;
    allow?: string[];
    preferredEditTool?: "patch" | "replace";
    customToolInput?: CustomToolInput;
    modelCapabilities?: Record<
      string,
      Pick<ModelCapabilities, "customToolInput" | "preferredEditTool">
    >;
    showNames?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "harness-code-"));
  roots.push(root);
  const provider = new FakeProvider(
    steps.map((step) =>
      step.map((event) =>
        event.type === "completed"
          ? { ...event, usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 3 } }
          : event,
      ),
    ),
  );
  const requests: ModelRequest[] = [];
  const recorded: ModelProvider = {
    provider: provider.provider,
    capabilities: (model) => ({
      ...provider.capabilities(),
      ...(options.customToolInput ? { customToolInput: options.customToolInput } : {}),
      ...options.modelCapabilities?.[model],
      ...(options.preferredEditTool ? { preferredEditTool: options.preferredEditTool } : {}),
    }),
    validateConfig: () => {},
    listModels: () => [],
    stream: (request) => {
      requests.push(request);
      return provider.stream();
    },
  };
  const store = options.store ?? new InMemoryStore();
  const subagents = new SubagentsDefinition();
  const svc = new HarnessService({
    store,
    home: join(root, "home"),
    codeEvaluator: new QuickJsEvaluator(),
    defaults: {
      model: { provider: "fake", model: "fake-1" },
      tools: {
        mode,
        ...(options.allow ? { allow: options.allow } : {}),
        ...(options.showNames === undefined ? {} : { showNames: options.showNames }),
      },
      plugins: { approval: { outOfWorkspace: "allow" }, ...pluginConfig },
    },
    plugins: [
      {
        id: "fake",
        providers: () => [recorded],
        tools: () => tools,
        ...(options.compaction ? { policies: () => ({ compaction: options.compaction! }) } : {}),
      },
      ...(options.execution === null ? [] : [options.execution ?? localExecutionPlugin]),
      activitiesPlugin,
      ...(options.execution === null ? [] : [workspacePlugin]),
      approvalPlugin,
      agentsPlugin,
      autoApprovalPlugin,
      outputPlugin,
      subagents,
    ],
  });
  subagents.bindRunner(svc);
  const events: HarnessEvent[] = [];
  svc.subscribe((event) => events.push(event));
  const conversation = await svc.createConversation({ cwd: root });
  sessions.push({ svc, id: conversation.id });
  const run = async () => {
    await svc.deliver(conversation.id, "perform the task", "send");
    await svc.whenIdle(conversation.id);
    return store.listActiveItems(conversation.id);
  };
  return { svc, store, requests, events, root, conversation, run };
}

const catalogTool = (name: string, description = "catalog fixture"): Tool => ({
  name,
  description,
  input: { kind: "function", schema: z.strictObject({}) },
  outputSchema: { type: "object", properties: { value: { type: "number" } } },
  exposure: { direct: false, code: true },
  execute: async () => ({ ...okResult("called"), structured: { value: 42 } }),
});
const discoveryOutput = (items: Item[], id: string) =>
  JSON.parse(textOf(results(items).find((item) => item.callId === id)!.content)) as {
    tools: {
      input: { name: string; description: string };
      outputSchema?: Record<string, unknown>;
    }[];
    oversized: string[];
  };

describe("ordinary tool discovery", () => {
  it.each(["hybrid", "code-only"] as const)(
    "%s lists only scoped deferred names by default without marking their definitions learned",
    async (mode) => {
      for (const showNames of [undefined, false]) {
        const fixture = await setup(
          [toolStep("search", "tool_search", { queries: ["deferred"] }), textStep("done")],
          [
            catalogTool("z_deferred"),
            catalogTool("a_deferred"),
            catalogTool("excluded_deferred"),
            { ...catalogTool("entry"), exposure: { direct: true, code: false }, essential: true },
          ],
          mode,
          {},
          {
            ...(showNames === undefined ? {} : { showNames }),
            allow: ["z_deferred", "a_deferred", "entry"],
          },
        );
        const items = await fixture.run();
        const descriptions = fixture.requests.map(
          (request) => request.tools!.find((tool) => tool.name === "eval")!.description,
        );
        if (showNames === false) expect(descriptions[0]).not.toContain("Deferred tool names:");
        else expect(descriptions[0]).toContain('Deferred tool names: ["a_deferred","z_deferred"]');
        expect(descriptions[1]).toBe(descriptions[0]);
        expect(descriptions[0]).not.toContain("excluded_deferred");
        expect(discoveryOutput(items, "search").tools.map((tool) => tool.input.name)).toEqual([
          "a_deferred",
          "z_deferred",
        ]);
      }
    },
  );

  it("hybrid declares only essential tools and gates ordinary direct calls consistently", async () => {
    const fixture = await setup(
      [
        toolStep("essential-direct", "basic", {}),
        toolStep("other-direct", "other", {}),
        evalStep('return await tools.call("other", {});'),
        textStep("done"),
      ],
      [
        { ...catalogTool("basic"), exposure: { direct: true, code: true }, essential: true },
        { ...catalogTool("other"), exposure: { direct: true, code: true } },
      ],
      "hybrid",
      {},
      { execution: null },
    );
    const items = await fixture.run();
    expect(fixture.requests[0]!.tools!.map((tool) => tool.name)).toEqual([
      "activity_kill",
      "activity_list",
      "activity_peek",
      "activity_wait",
      "basic",
      "eval",
      "subagent",
      "subagent_dismiss",
      "subagent_list",
      "subagent_send",
      "tool_describe",
      "tool_search",
    ]);
    expect(results(items).find((item) => item.callId === "essential-direct")?.status).toBe("ok");
    expect(results(items).find((item) => item.callId === "other-direct")?.status).toBe("error");
    expect(results(items).find((item) => item.parentCallId === "outer")?.status).toBe("ok");
    expect(
      fixture.requests[0]!.tools!.find((tool) => tool.name === "eval")?.description,
    ).not.toContain('"name":"basic"');
  });
  it("offers discovery in every mode and never promotes deferred tools to direct calls", async () => {
    for (const mode of ["hybrid", "code-only"] as const) {
      const fixture = await setup(
        [
          toolStep("search", "tool_search", { queries: ["catalog"] }),
          toolStep("describe", "tool_describe", { name: "catalog_item" }),
          toolStep("guess", "catalog_item", {}),
          evalStep('return await tools.call("catalog_item", {});'),
          textStep("done"),
        ],
        [catalogTool("catalog_item")],
        mode,
        { approval: { inWorkspace: "deny", outOfWorkspace: "deny" } },
      );
      const items = await fixture.run();
      const visible = fixture.requests[0]!.tools!.map((tool) => tool.name);
      expect(visible).toContain("tool_search");
      expect(visible).toContain("tool_describe");
      expect(visible).not.toContain("catalog_item");
      expect(discoveryOutput(items, "search").tools[0]?.input.name).toBe("catalog_item");
      expect(results(items).find((item) => item.callId === "describe")?.status).toBe("ok");
      expect(results(items).find((item) => item.callId === "guess")?.status).toBe("error");
      expect(textOf(results(items).find((item) => item.callId === "guess")!.content)).toContain(
        "unavailable through model interface",
      );
      for (const request of fixture.requests)
        expect(request.tools?.map((tool) => tool.name)).not.toContain("catalog_item");
      expect(results(items).find((item) => item.parentCallId)?.status).toBe("error");
      expect(
        fixture.events.some((event) => isKernelEvent(event) && event.type === "request.created"),
      ).toBe(false);
    }
  });

  it("skips already declared and discovered tools before limiting searches, while describe stays explicit", async () => {
    const tools = Array.from({ length: 15 }, (_, i) =>
      catalogTool(`catalog_${String(i).padStart(2, "0")}`),
    );
    tools[0] = { ...tools[0]!, exposure: { direct: true, code: true }, essential: true };
    const fixture = await setup(
      [
        toolStep("pre-described", "tool_describe", { name: "catalog_13" }),
        toolStep("first", "tool_search", { queries: ["catalog"] }),
        toolStep("overlap", "tool_search", { queries: ["fixture catalog"] }),
        toolStep("again", "tool_search", { queries: ["catalog"] }),
        toolStep("describe1", "tool_describe", { name: "catalog_00" }),
        toolStep("describe2", "tool_describe", { name: "catalog_00" }),
        textStep("done"),
      ],
      tools,
      "hybrid",
    );
    const items = await fixture.run();
    const first = discoveryOutput(items, "first").tools.map((tool) => tool.input.name);
    expect(first).toHaveLength(12);
    expect(first).not.toContain("catalog_00");
    expect(discoveryOutput(items, "overlap").tools.map((tool) => tool.input.name)).toEqual([
      "catalog_14",
    ]);
    expect(discoveryOutput(items, "again").tools).toEqual([]);
    for (const id of ["describe1", "describe2"]) {
      const item = results(items).find((item) => item.callId === id)!;
      expect(JSON.parse(textOf(item.content))).toMatchObject({
        input: { name: "catalog_00" },
        outputSchema: tools[0].outputSchema,
      });
    }
  });

  it("derives discovery from the current branch across reload, actual compaction, and rewind", async () => {
    const fixture = await setup(
      [
        toolStep("learn", "tool_search", { queries: ["catalog"] }),
        textStep("done"),
        toolStep("reload", "tool_search", { queries: ["catalog"] }),
        textStep("done"),
        textStep("summary"),
        toolStep("fold", "tool_search", { queries: ["catalog"] }),
        textStep("done"),
        toolStep("rewind-known", "tool_search", { queries: ["catalog"] }),
        textStep("done"),
        toolStep("rewind-new", "tool_search", { queries: ["catalog"] }),
        textStep("done"),
      ],
      [catalogTool("catalog_item")],
      "code-only",
      {},
      { compaction: modelCompaction },
    );
    const first = await fixture.run();
    const learned = results(first).find((item) => item.callId === "learn")!;
    const before = first.find((item) => item.type === "message" && item.role === "user")!;
    expect(discoveryOutput(first, "learn").tools).toHaveLength(1);
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
    await fixture.svc.prepare(fixture.conversation.id);
    expect(discoveryOutput(await fixture.run(), "reload").tools).toEqual([]);
    expect(await fixture.svc.compact(fixture.conversation.id)).toBe("compacted");
    expect(discoveryOutput(await fixture.run(), "fold").tools).toHaveLength(1);
    await fixture.svc.rewind(fixture.conversation.id, learned.id);
    expect(discoveryOutput(await fixture.run(), "rewind-known").tools).toEqual([]);
    await fixture.svc.rewind(fixture.conversation.id, before.id);
    expect(discoveryOutput(await fixture.run(), "rewind-new").tools).toHaveLength(1);
  });

  it("delivers complete bounded definitions through shipped and no-execution compositions", async () => {
    for (const execution of [localExecutionPlugin, null]) {
      const fixture = await setup(
        [
          toolStep("search", "tool_search", { queries: ["catalog"] }),
          toolStep("large", "tool_describe", { name: "catalog_large" }),
          toolStep("again", "tool_search", { queries: ["catalog"] }),
          textStep("done"),
        ],
        [
          catalogTool("catalog_large", `catalog ${"é".repeat(40000)}`),
          catalogTool("catalog_small", `catalog ${"é".repeat(12000)}`),
        ],
        "code-only",
        {},
        { execution },
      );
      const items = await fixture.run();
      expect(
        fixture.events.filter(
          (event) => isKernelEvent(event) && event.type === "turn.status" && event.error,
        ),
      ).toEqual([]);
      const output = discoveryOutput(items, "search");
      expect(output.tools.map((tool) => tool.input.name)).toEqual(["catalog_small"]);
      expect(output.tools[0]!.input.description).toBe(`catalog ${"é".repeat(12000)}`);
      expect(output.oversized).toEqual(["catalog_large"]);
      expect(
        results(items).find((item) => item.callId === "search")?.annotations?.toolDiscovery,
      ).toEqual(["catalog_small"]);
      expect(
        Buffer.byteLength(textOf(results(items).find((item) => item.callId === "search")!.content)),
      ).toBeLessThanOrEqual(64 * 1024);
      expect(results(items).find((item) => item.callId === "large")?.status).toBe("error");
      expect(
        results(items).find((item) => item.callId === "large")?.annotations?.toolDiscovery,
      ).toBeUndefined();
      expect(discoveryOutput(items, "again")).toMatchObject({
        tools: [],
        oversized: ["catalog_large"],
      });
    }
  });

  it("does not learn from an interrupted discovery or expose discovery inside eval", async () => {
    const reading = gate();
    const release = gate();
    let pause = true;
    class DiscoveryStore extends InMemoryStore {
      override async listActiveItems(id: ConversationId): Promise<Item[]> {
        const items = await super.listActiveItems(id);
        if (pause && items.some((item) => item.type === "tool_call" && item.callId === "cancel")) {
          pause = false;
          reading.resolve();
          await release.promise;
        }
        return items;
      }
    }
    const fixture = await setup(
      [
        toolStep("cancel", "tool_search", { queries: ["catalog"] }),
        toolStep("next", "tool_search", { queries: ["catalog"] }),
        evalStep('return await tools.call("tool_describe", {name:"catalog_item"});'),
        textStep("done"),
      ],
      [catalogTool("catalog_item")],
      "code-only",
      {},
      { store: new DiscoveryStore() },
    );
    const running = fixture.run();
    await reading.promise;
    fixture.svc.cancelSession(fixture.conversation.id);
    release.resolve();
    const interrupted = await running;
    expect(results(interrupted).find((item) => item.callId === "cancel")?.status).toBe("error");
    expect(
      results(interrupted).find((item) => item.callId === "cancel")?.annotations?.toolDiscovery,
    ).toBeUndefined();
    const items = await fixture.run();
    expect(discoveryOutput(items, "next").tools).toHaveLength(1);
    expect(results(items).find((item) => item.parentCallId)?.status).toBe("error");
  });

  it("prioritizes a near-limit complete definition over oversized notices in either rank order", async () => {
    for (const oversizedFirst of [false, true]) {
      const fittingName = oversizedFirst ? "z_catalog" : "a_catalog";
      const oversizedName = oversizedFirst ? "a_catalog" : "z_catalog";
      const calibration = await setup(
        [toolStep("measure", "tool_describe", { name: fittingName }), textStep("done")],
        [catalogTool(fittingName, "")],
      );
      const measured = await calibration.run();
      const definition = JSON.parse(
        textOf(results(measured).find((item) => item.callId === "measure")!.content),
      ) as ToolContract;
      const room =
        64 * 1024 -
        Buffer.byteLength(JSON.stringify({ tools: [definition], oversized: [], more: false }));
      const description = "x".repeat(room);
      const fixture = await setup(
        [
          toolStep("first", "tool_search", { queries: ["catalog"] }),
          toolStep("next", "tool_search", { queries: ["catalog"] }),
          textStep("done"),
        ],
        [catalogTool(fittingName, description), catalogTool(oversizedName, "x".repeat(70000))],
      );
      const items = await fixture.run();
      const item = results(items).find((candidate) => candidate.callId === "first")!;
      expect(item.status).toBe("ok");
      expect(discoveryOutput(items, "first").tools).toMatchObject([
        { input: { name: fittingName, description } },
      ]);
      expect(item.annotations?.toolDiscovery).toEqual([fittingName]);
      expect(Buffer.byteLength(textOf(item.content))).toBeLessThanOrEqual(64 * 1024);
      expect(discoveryOutput(items, "next")).toMatchObject({
        tools: [],
        oversized: [oversizedName],
      });
    }
  });

  it("accepts 32 distinct search terms and rejects 33 without learning results", async () => {
    const terms = Array.from({ length: 33 }, (_, i) => `t${i}`);
    const fixture = await setup(
      [
        toolStep("valid", "tool_search", { queries: [terms.slice(0, 32).join(" ")] }),
        toolStep("invalid", "tool_search", { queries: [terms.join(" ")] }),
        textStep("done"),
      ],
      [catalogTool("catalog_item", terms.join(" "))],
    );
    const items = await fixture.run();
    expect(discoveryOutput(items, "valid").tools).toHaveLength(1);
    const invalid = results(items).find((item) => item.callId === "invalid")!;
    expect(invalid.status).toBe("error");
    expect(textOf(invalid.content)).toContain("32 terms");
    expect(invalid.annotations?.toolDiscovery).toBeUndefined();
  });

  it("ANDs words within each query and ORs alternatives without a plugin-specific filter", async () => {
    const fixture = await setup(
      [
        toolStep("search", "tool_search", { queries: ["gitlab issues", "gitlab merge requests"] }),
        textStep("done"),
      ],
      [
        catalogTool("gitlab_issue", "gitlab issues"),
        catalogTool("gitlab_merge", "gitlab merge requests"),
        catalogTool("other_issue", "another server issues"),
      ],
    );
    const items = await fixture.run();
    expect(
      discoveryOutput(items, "search")
        .tools.map((tool) => tool.input.name)
        .sort(),
    ).toEqual(["gitlab_issue", "gitlab_merge"]);
  });

  it("keeps essential tools out of discovery and rejects direct calls in code-only", async () => {
    const fixture = await setup(
      [
        toolStep("search", "tool_search", { queries: ["essential"] }),
        toolStep("direct", "essential_tool", {}),
        evalStep('return await tools.call("essential_tool", {});'),
        textStep("done"),
      ],
      [{ ...catalogTool("essential_tool", "essential fixture"), essential: true }],
    );
    const items = await fixture.run();
    expect(discoveryOutput(items, "search").tools).toEqual([]);
    expect(results(items).find((item) => item.callId === "direct")?.status).toBe("error");
    expect(results(items).find((item) => item.parentCallId === "outer")?.status).toBe("ok");
  });

  it("keeps upfront definitions scoped and present after compaction", async () => {
    const fixture = await setup(
      [textStep("done"), textStep("summary"), textStep("done again")],
      [
        { ...catalogTool("allowed_tool"), essential: true },
        { ...catalogTool("excluded_tool"), essential: true },
      ],
      "code-only",
      {},
      { allow: ["allowed_tool"], compaction: modelCompaction },
    );
    await fixture.run();
    await fixture.svc.compact(fixture.conversation.id);
    await fixture.run();
    for (const request of fixture.requests.filter((request) =>
      request.tools?.some((tool) => tool.name === "eval"),
    )) {
      const description = request.tools!.find((tool) => tool.name === "eval")!.description;
      expect(description).toContain('"name":"allowed_tool"');
      expect(description).not.toContain('"name":"excluded_tool"');
    }
  });

  it.each(["patch", "replace"] as const)(
    "uses the model's %s workspace roster upfront",
    async (preferredEditTool) => {
      const fixture = await setup([textStep("done")], [], "code-only", {}, { preferredEditTool });
      await fixture.run();
      const description = fixture.requests[0]!.tools!.find(
        (tool) => tool.name === "eval",
      )!.description;
      expect(description).toContain(
        `"name":"${preferredEditTool === "replace" ? "edit" : "apply_patch"}"`,
      );
    },
  );

  it.each(["hybrid", "code-only"] as const)(
    "describes workspace contracts upfront only in %s code-only mode",
    async (mode) => {
      const fixture = await setup([textStep("done")], [], mode);
      await fixture.run();
      const tools = fixture.requests[0]!.tools!;
      const evaluator = tools.find((tool) => tool.name === "eval");
      if (mode === "code-only") {
        const shell = process.platform === "win32" ? "powershell" : "bash";
        expect(tools.map((tool) => tool.name)).not.toContain(shell);
        expect(evaluator?.description).toContain(`"name":"${shell}"`);
        expect(evaluator?.description).toContain("inside eval only");
        expect(evaluator?.description).toContain('"name":"read_file"');
      } else {
        expect(evaluator?.description ?? "").not.toContain("inside eval only");
      }
    },
  );
});

describe("recorded code-mode execution", () => {
  it("chains real glob/read tools, selects output, and stages nested instructions after the outer result", async () => {
    const fixture = await setup([
      evalStep(`const {paths} = await tools.call("glob", {pattern:"src/*.txt"});
      return await Promise.all(paths.map(async path => ({path, first:(await tools.call("read_file", {path})).text.slice(0, 5)})));`),
      textStep("done"),
    ]);
    await mkdir(join(fixture.root, "src"));
    await writeFile(join(fixture.root, "src/AGENTS.md"), "nested instruction");
    await writeFile(join(fixture.root, "src/a.txt"), "hello hidden intermediate");
    await writeFile(join(fixture.root, "src/b.txt"), "world hidden intermediate");
    const items = await fixture.run();
    expect(results(items).find((item) => item.callId === "outer")?.content).toEqual([
      {
        type: "text",
        text: '[{"path":"src/a.txt","first":"hello"},{"path":"src/b.txt","first":"world"}]',
      },
    ]);
    expect(
      calls(items)
        .filter((item) => item.parentCallId === "outer")
        .map((item) => item.name),
    ).toEqual(["glob", "read_file", "read_file"]);
    expect(fixture.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "eval",
      "tool_describe",
      "tool_search",
    ]);
    expect(JSON.stringify(fixture.requests[1])).not.toContain("hidden intermediate");
    expect(
      fixture.requests[1]?.items
        .filter(({ item }) => item.type === "tool_call")
        .map(({ item }) => (item.type === "tool_call" ? item.callId : "")),
    ).toEqual(["outer"]);
    expect(items.findIndex((item) => item.type === "context")).toBeGreaterThan(
      items.findIndex((item) => item.type === "tool_result" && item.callId === "outer"),
    );
    expect(
      textOf(
        fixture.requests[1]!.items.flatMap(({ item }) => ("content" in item ? item.content : [])),
      ),
    ).toContain("nested instruction");
    const projected = fixture.requests[1]!;
    const responseInput = buildResponseParams(projected, undefined, "fake", false).input;
    expect(responseInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "outer", name: "eval" }),
        expect.objectContaining({ type: "function_call_output", call_id: "outer" }),
      ]),
    );
    const chat = buildChatParams(projected);
    expect(chat.messages.filter((message) => message.role === "tool")).toEqual([
      expect.objectContaining({ role: "tool", tool_call_id: "outer" }),
    ]);
    const anthropic = buildMessages(projected, { maxTokens: 1024 }, "fake");
    const blocks = anthropic.messages.flatMap((message) =>
      typeof message.content === "string" ? [] : message.content,
    );
    expect(blocks.filter((block) => block.type === "tool_use")).toEqual([
      expect.objectContaining({ id: "outer", name: "eval" }),
    ]);
    expect(blocks.filter((block) => block.type === "tool_result")).toEqual([
      expect.objectContaining({ tool_use_id: "outer" }),
    ]);
    for (const request of [responseInput, chat, anthropic])
      expect(JSON.stringify(request)).not.toContain("hidden intermediate");
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
  });

  it("discovers deferred tools and effective activity/subagent contracts while enforcing exposure", async () => {
    const deferred: Tool = {
      name: "server.issue_search",
      description: "Find issues",
      input: { kind: "function", schema: z.strictObject({}) },
      exposure: { direct: false, code: true },
      execute: async () => ({ ...okResult("issues"), structured: [42] }),
    };
    const directOnly: Tool = {
      ...deferred,
      name: "entry",
      exposure: { direct: true, code: false },
      essential: true,
    };
    const fixture = await setup(
      [
        toolStep("search", "tool_search", { queries: ["issue"] }),
        toolStep("shell", "tool_describe", {
          name: process.platform === "win32" ? "powershell" : "bash",
        }),
        toolStep("agent", "tool_describe", { name: "subagent" }),
        evalStep('return await tools.call("server.issue_search", {});'),
        toolStep("alternate", "server.issue_search", {}),
        toolStep("entry-eval", "eval", { code: 'return await tools.call("entry", {});' }),
        textStep("done"),
      ],
      [deferred, directOnly],
      "hybrid",
    );
    const items = await fixture.run();
    const visible = fixture.requests[0]!.tools!.map((tool) => tool.name);
    expect(visible).toContain("eval");
    expect(visible).toContain("entry");
    expect(visible).not.toContain("server.issue_search");
    const output = (id: string): unknown =>
      JSON.parse(textOf(results(items).find((item) => item.callId === id)!.content));
    expect(discoveryOutput(items, "search").tools[0]?.input.name).toBe("server.issue_search");
    const shell = output("shell") as {
      input: { parameters: { properties: Record<string, unknown> } };
    };
    expect(shell.input.parameters.properties.background).toBeDefined();
    expect((output("agent") as ToolContract).input.description).toContain("explore");
    expect(output("outer")).toEqual([42]);
    expect(results(items).find((item) => item.callId === "alternate")?.status).toBe("error");
    expect(results(items).at(-1)?.status).toBe("error");
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
  });

  it("blocks guessed direct calls in code-only mode and calls freeform tools through the ordinary parser", async () => {
    const custom: Tool = {
      name: "patch",
      description: "raw patch",
      input: {
        kind: "custom",
        jsonField: "patch",
        parse: (raw) => {
          if (!raw.startsWith("PATCH:")) throw new Error("bad patch");
          return raw.slice(6);
        },
      },
      execute: async (value) => okResult(String(value)),
    };
    const fixture = await setup(
      [
        toolStep("bypass", "patch", "PATCH:bad route"),
        evalStep('return await tools.call("patch", "PATCH:accepted");'),
        textStep("done"),
      ],
      [custom],
    );
    const items = await fixture.run();
    expect(results(items)[0]!.status).toBe("error");
    expect(results(items).find((item) => item.parentCallId)?.content).toEqual([
      { type: "text", text: "accepted" },
    ]);
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
  });

  it("reviews computed arguments, records denials before the next review, and never replays completed effects", async () => {
    let executions = 0;
    const update: Tool = {
      name: "github.update_issue",
      description: "Update an issue's labels",
      input: {
        kind: "function",
        schema: z.strictObject({ number: z.number(), labels: z.array(z.string()) }),
      },
      execute: async () => {
        executions++;
        return okResult("updated");
      },
    };
    const fixture = await setup(
      [
        evalStep(`emit("start"); await tools.call("github.update_issue", {number:42, labels:["triaged"]});
      try { await tools.call("github.update_issue", {number:43, labels:["triaged"]}); } catch {}
      await tools.call("github.update_issue", {number:44, labels:["triaged"]});`),
        textStep("YES"),
        textStep("NO\nunauthorized update"),
        textStep("NO\nprevious denial remains applicable"),
        textStep("done"),
      ],
      [update],
      "code-only",
      {
        approval: { outOfWorkspace: "allow", tools: { "github.update_issue": "ask" } },
        "auto-approval": { enabled: true },
      },
    );
    const items = await fixture.run();
    expect(executions).toBe(1);
    expect(
      results(items)
        .filter((item) => item.parentCallId)
        .map((item) => item.status),
    ).toEqual(["ok", "error", "error"]);
    const review = JSON.stringify(fixture.requests[3]);
    expect(review).toContain("prior approval denial");
    expect(review).toContain("unauthorized update");
    expect(review).toContain("Update an issue");
    expect(review).toContain("44");
    expect(review).toContain("outer");
    expect(textOf(results(items).at(-1)!.content)).toContain('"start"');
    expect(results(items).at(-1)!.status).toBe("error");
    expect(await fixture.store.summarizeModelUsage(fixture.conversation.id)).toMatchObject({
      incomplete: false,
      usage: { inputTokens: 50, outputTokens: 10, cachedReadTokens: 15 },
    });
    const usage = await fixture.store.listModelUsage(fixture.conversation.id);
    expect(usage).toHaveLength(5);
    expect(new Set(usage.map((row) => row.id)).size).toBe(5);
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
  });

  it("keeps human approval pending in a live guest promise and cancels every recorded call", async () => {
    const proposed = gate();
    let executions = 0;
    const tool: Tool = {
      name: "update",
      description: "Update",
      input: { kind: "function", schema: z.strictObject({ id: z.number() }) },
      execute: async () => {
        executions++;
        return okResult("updated");
      },
    };
    const fixture = await setup(
      [evalStep('await tools.call("update", {id:42});')],
      [tool],
      "code-only",
      { approval: { outOfWorkspace: "ask" } },
    );
    fixture.svc.subscribe((event) => {
      if (
        isKernelEvent(event) &&
        event.type === "request.created" &&
        isApprovalRequest(event.request)
      ) {
        expect(event.request.call.parentCallId).toBe("outer");
        expect(event.request.call.args).toEqual({ id: 42 });
        proposed.resolve();
      }
    });
    const running = fixture.run();
    await proposed.promise;
    await fixture.svc.deliver(fixture.conversation.id, "", "interrupt");
    const items = await running;
    expect(executions).toBe(0);
    expect(results(items)).toHaveLength(calls(items).length);
    expect(results(items).every((item) => item.status === "error")).toBe(true);
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
  });

  it("overlaps ordinary foreground commands submitted concurrently", async () => {
    const both = gate(),
      release = gate();
    const started: string[] = [];
    class ControlledCommands extends LocalExecutionContext {
      override spawn(command: string) {
        started.push(command);
        if (started.length === 2) both.resolve();
        return {
          pid: undefined,
          exit: release.promise.then(() => ({ code: 0, signal: null })),
          onData: () => {},
          kill: () => release.resolve(),
        };
      }
    }
    const backend = new ControlledCommands(null);
    const fixture = await setup(
      [
        evalStep(
          `return await Promise.all([tools.call("${backend.shellKind}", {command:"first"}), tools.call("${backend.shellKind}", {command:"second"})]);`,
        ),
        textStep("done"),
      ],
      [],
      "code-only",
      {},
      {
        execution: {
          id: "controlled-commands",
          services: () => [{ key: "execution", for: () => backend }],
        },
      },
    );
    const running = fixture.run();
    await both.promise;
    expect(started).toEqual(["first", "second"]);
    expect(
      results(await fixture.store.listActiveItems(fixture.conversation.id)).filter(
        (item) => item.parentCallId,
      ),
    ).toHaveLength(0);
    release.resolve();
    const items = await running;
    const children = results(items).filter((item) => item.parentCallId);
    expect(children).toHaveLength(2);
    expect(children.every((item) => item.status === "ok")).toBe(true);
    expect(
      children.every(
        (item) => item.seq < results(items).find((item) => item.callId === "outer")!.seq,
      ),
    ).toBe(true);
  });

  it("preserves sequential await and direct model batch ordering", async () => {
    for (const mode of ["code-only", "hybrid"] as const) {
      const first = gate(),
        release = gate();
      const order: string[] = [];
      const operation: Tool = {
        name: "operation",
        essential: true,
        description: "Ordered operation",
        input: { kind: "function", schema: z.strictObject({ name: z.string() }) },
        execute: async (args) => {
          const { name } = args as { name: string };
          order.push(name);
          if (name === "first") {
            first.resolve();
            await release.promise;
          }
          return okResult(name);
        },
      };
      const fixture = await setup(
        [
          mode === "code-only"
            ? evalStep(
                'await tools.call("operation", {name:"first"}); return await tools.call("operation", {name:"second"});',
              )
            : [
                { type: "tool_call", callId: "first", name: "operation", args: { name: "first" } },
                ...toolStep("second", "operation", { name: "second" }),
              ],
          textStep("done"),
        ],
        [operation],
        mode,
      );
      const running = fixture.run();
      await first.promise;
      expect(order).toEqual(["first"]);
      if (mode === "code-only")
        expect(
          calls(await fixture.store.listActiveItems(fixture.conversation.id)).filter(
            (item) => item.parentCallId,
          ),
        ).toHaveLength(1);
      release.resolve();
      const items = await running;
      expect(order).toEqual(["first", "second"]);
      expect(results(items)).toHaveLength(calls(items).length);
    }
  });

  it("inherits code mode into an actual restricted subagent and cannot discover or invoke withheld tools", async () => {
    const fixture = await setup(
      [
        evalStep(
          'return await tools.call("subagent", {agent:"reader", name:"Reader task", slug:"reader-task", task:"attempt unavailable writer"});',
        ),
        toolStep("child-search", "tool_search", { queries: ["write_file"] }),
        toolStep("child-describe", "tool_describe", { name: "write_file" }),
        toolStep("child-eval", "eval", {
          code: 'return await tools.call("write_file", {path:"forbidden.txt",content:"bad"});',
        }),
        textStep("child done"),
        textStep("parent done"),
      ],
      [],
      "code-only",
      {
        subagents: {
          agents: [
            {
              name: "reader",
              description: "Read only",
              systemPrompt: "read",
              tools: { allow: ["read_file", "glob"] },
            },
          ],
        },
      },
    );
    const items = await fixture.run();
    const conversations = await fixture.store.listConversations();
    const child = conversations.find((item) => item.id !== fixture.conversation.id)!;
    const childItems = await fixture.store.listActiveItems(child.id);
    expect(calls(childItems).find((item) => item.name === "write_file")?.parentCallId).toBe(
      "child-eval",
    );
    expect(results(childItems).find((item) => item.parentCallId)?.status).toBe("error");
    const childOutput = textOf(
      results(childItems).find((item) => item.callId === "child-eval")!.content,
    );
    expect(discoveryOutput(childItems, "child-search").tools).toEqual([]);
    expect(results(childItems).find((item) => item.callId === "child-describe")?.status).toBe(
      "error",
    );
    expect(childOutput).toContain("unknown tool: write_file");
    await expect(readFile(join(fixture.root, "forbidden.txt"), "utf8")).rejects.toThrow();
    expect(results(items).at(-1)?.status).toBe("ok");
    expect(fixture.requests[1]?.tools?.map((tool) => tool.name)).toEqual([
      "eval",
      "tool_describe",
      "tool_search",
    ]);
    for (const id of [child.id, fixture.conversation.id]) {
      const steps = id === child.id ? 4 : 2;
      expect(await fixture.store.listModelUsage(id)).toHaveLength(steps);
      expect(await fixture.store.summarizeModelUsage(id)).toMatchObject({
        incomplete: false,
        usage: { inputTokens: 10 * steps, outputTokens: 2 * steps, cachedReadTokens: 3 * steps },
      });
    }
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
  });

  it("keeps ordinary background activity meaning and waiting available inside code", async () => {
    const shell = process.platform === "win32" ? "powershell" : "bash";
    const waiting = gate(),
      release = gate();
    let output!: (chunk: string) => void;
    class ControlledCommand extends LocalExecutionContext {
      override spawn() {
        return {
          pid: undefined,
          exit: release.promise.then(() => ({ code: 0, signal: null })),
          onData: (listener: (chunk: string) => void) => {
            output = listener;
          },
          kill: () => release.resolve(),
        };
      }
    }
    const fixture = await setup(
      [
        evalStep(`const activity = await tools.call(${JSON.stringify(shell)}, {command:"activity fixture", background:true});
      emit(activity.state); return await tools.call("activity_wait", {id:activity.activityId});`),
        textStep("done"),
      ],
      [],
      "code-only",
      {},
      {
        execution: {
          id: "controlled-background-command",
          services: () => [
            {
              key: "execution",
              for: (conversation) => new ControlledCommand(conversation.workspaceRoot),
            },
          ],
        },
      },
    );
    fixture.svc.subscribe((event) => {
      if (
        isKernelEvent(event) &&
        event.type === "item.appended" &&
        event.item.type === "tool_call" &&
        event.item.name === "activity_wait" &&
        event.item.parentCallId === "outer"
      )
        waiting.resolve();
    });
    const running = fixture.run();
    await waiting.promise;
    const pending = results(await fixture.store.listActiveItems(fixture.conversation.id));
    expect(pending.find((item) => item.parentCallId === "outer")?.structured).toMatchObject({
      state: "running",
    });
    expect(pending.some((item) => item.callId === "outer")).toBe(false);
    output("activity output");
    release.resolve();
    const items = await running;
    expect(textOf(results(items).at(-1)!.content)).toContain('"running"');
    expect(textOf(results(items).at(-1)!.content)).toContain("activity output");
    await fixture.svc.deactivateSession(fixture.conversation.id, { force: true });
  });

  it("cancels unawaited children on return or throw and pairs them before completing the evaluator", async () => {
    for (const end of ['return "end";', 'throw new Error("later failure");']) {
      let cancelled = 0;
      const holding: Tool = {
        name: "hold",
        description: "controlled wait",
        input: { kind: "function", schema: z.strictObject({ wait: z.boolean() }) },
        execute: async (args, ctx) => {
          if (!(args as { wait: boolean }).wait) return okResult("ready");
          return new Promise((resolve) =>
            ctx.signal.addEventListener(
              "abort",
              () => {
                cancelled++;
                resolve(okResult("stopped"));
              },
              { once: true },
            ),
          );
        },
      };
      const fixture = await setup(
        [
          evalStep(
            `void tools.call("hold", {wait:true}); await tools.call("hold", {wait:false}); emit("before"); ${end}`,
          ),
          textStep("done"),
        ],
        [holding],
      );
      const items = await fixture.run();
      expect(cancelled).toBe(1);
      expect(results(items)).toHaveLength(calls(items).length);
      const outer = results(items).find((item) => item.callId === "outer")!;
      expect(
        results(items)
          .filter((item) => item.parentCallId)
          .every((item) => item.seq < outer.seq),
      ).toBe(true);
      expect(textOf(outer.content)).toContain('"before"');
      expect(outer.status).toBe(end.startsWith("return") ? "ok" : "error");
    }
  });

  it("preserves emitted output when cancelling multiple running children, then accepts the next turn", async () => {
    const started = gate();
    let executions = 0;
    let cancelled = 0;
    const holding: Tool = {
      name: "hold",
      description: "wait",
      input: { kind: "function", schema: z.strictObject({}) },
      execute: async (_args, ctx) => {
        if (++executions === 2) started.resolve();
        return new Promise((resolve) =>
          ctx.signal.addEventListener(
            "abort",
            () => {
              cancelled++;
              resolve(okResult("stopped"));
            },
            { once: true },
          ),
        );
      },
    };
    const fixture = await setup(
      [
        evalStep(
          'emit("before"); await Promise.all([tools.call("hold", {}), tools.call("hold", {})]);',
        ),
        toolStep("recovery", "eval", { code: "return 42;" }),
        textStep("done"),
      ],
      [holding],
    );
    const running = fixture.run();
    await started.promise;
    await fixture.svc.deliver(fixture.conversation.id, "", "interrupt");
    const items = await running;
    expect(cancelled).toBe(2);
    expect(textOf(results(items).find((item) => item.callId === "outer")!.content)).toContain(
      '"before"',
    );
    expect(results(items)).toHaveLength(calls(items).length);
    const outer = results(items).find((item) => item.callId === "outer")!;
    const children = results(items).filter((item) => item.parentCallId);
    expect(children).toHaveLength(2);
    expect(children.every((item) => item.status === "error" && item.seq < outer.seq)).toBe(true);
    const recovered = await fixture.run();
    expect(textOf(results(recovered).find((item) => item.callId === "recovery")!.content)).toBe(
      "42",
    );
  });

  it("persists structured outputs inline or by bounded reference without exposing them in model context", async () => {
    const data: Tool = {
      name: "data",
      description: "structured",
      input: { kind: "function", schema: z.strictObject({ large: z.boolean() }) },
      execute: async (args, ctx) => ({
        ...okResult("presentation"),
        structured: (args as { large: boolean }).large ? "x".repeat(100000) : { records: [42] },
        full: await (ctx as import("@harness/protocol").ToolMiddlewareContext).putBlob(
          Buffer.from("raw full output"),
        ),
      }),
    };
    const fixture = await setup(
      [
        evalStep(
          'const small = await tools.call("data", {large:false}); const large = await tools.call("data", {large:true}); return [small.records, large.length];',
        ),
        textStep("done"),
      ],
      [data],
    );
    const items = await fixture.run();
    const nested = results(items).filter((item) => item.parentCallId);
    expect(nested[0]!.structured).toEqual({ records: [42] });
    expect(nested[1]!.structured).toBeUndefined();
    expect(nested[1]!.structuredRef?.bytes).toBeGreaterThan(100000);
    expect(
      JSON.parse(Buffer.from(await fixture.store.getBlob(nested[1]!.structuredRef!)).toString()),
    ).toBe("x".repeat(100000));
    expect(nested[0]!.full).toBeDefined();
    expect(JSON.stringify(fixture.requests[1])).not.toContain("structuredRef");
  });

  it("retains caught denial evidence across a fold without returning inner history to the main agent", async () => {
    const lookup: Tool = {
      name: "evidence",
      description: "Lookup evidence",
      input: { kind: "function", schema: z.strictObject({}) },
      execute: async () => okResult("retained lookup fact"),
    };
    const update: Tool = {
      name: "risky",
      description: "Update records",
      input: { kind: "function", schema: z.strictObject({ id: z.number() }) },
      execute: async () => okResult("updated"),
    };
    const fixture = await setup(
      [
        evalStep(
          'await tools.call("evidence", {}); try { await tools.call("risky", {id:1}); } catch {} return "caught";',
        ),
        textStep("NO\nnot authorized"),
        textStep("done"),
        toolStep("after-fold", "eval", { code: 'return await tools.call("risky", {id:2});' }),
        textStep("NO\nstill unauthorized"),
        textStep("done"),
      ],
      [update, lookup],
      "code-only",
      {
        approval: { outOfWorkspace: "allow", tools: { risky: "ask" } },
        "auto-approval": { enabled: true },
      },
    );
    await fixture.run();
    const fold = await fixture.store.createTurn(fixture.conversation.id);
    await fixture.store.appendItem({
      conversationId: fixture.conversation.id,
      turnId: fold.id,
      type: "compaction",
      content: [{ type: "text", text: "Task continues; selected result was caught." }],
    });
    await fixture.store.updateTurn(fold.id, "completed");
    await fixture.run();
    const mainAfterFold = fixture.requests[3]!;
    expect(JSON.stringify(mainAfterFold)).not.toContain("not authorized");
    expect(JSON.stringify(mainAfterFold)).not.toContain("retained lookup fact");
    const reviewer = JSON.stringify(fixture.requests[4]);
    expect(reviewer).toContain("not authorized");
    expect(reviewer).toContain("prior approval denial");
    expect(reviewer).toContain("parent call: outer");
    expect(reviewer).toContain("retained lookup fact");
  });

  it("resumes actual human approvals for allow and deny and stops admission after cancellation", async () => {
    for (const decision of ["allow", "deny"] as const) {
      let executions = 0;
      const update: Tool = {
        name: "update",
        description: "update",
        input: { kind: "function", schema: z.strictObject({ id: z.number() }) },
        execute: async () => {
          executions++;
          return okResult("updated");
        },
      };
      const fixture = await setup(
        [evalStep('return await tools.call("update", {id:6*7});'), textStep("done")],
        [update],
        "code-only",
        { approval: { outOfWorkspace: "ask" } },
      );
      fixture.svc.subscribe((event) => {
        if (
          isKernelEvent(event) &&
          event.type === "request.created" &&
          isApprovalRequest(event.request)
        ) {
          expect(event.request.call.args).toEqual({ id: 42 });
          fixture.svc.respond(fixture.conversation.id, event.requestId, { decision });
        }
      });
      const items = await fixture.run();
      expect(executions).toBe(decision === "allow" ? 1 : 0);
      expect(results(items).map((item) => item.status)).toEqual(
        decision === "allow" ? ["ok", "ok"] : ["error", "error"],
      );
    }
    let executions = 0;
    const update: Tool = {
      name: "update",
      description: "update",
      input: { kind: "function", schema: z.strictObject({}) },
      execute: async () => {
        executions++;
        return okResult("updated");
      },
    };
    const fixture = await setup(
      [evalStep('emit("before"); await tools.call("update", {});')],
      [update],
      "code-only",
      { approval: { outOfWorkspace: "ask" } },
    );
    fixture.svc.subscribe((event) => {
      if (isKernelEvent(event) && event.type === "request.created")
        fixture.svc.respond(fixture.conversation.id, event.requestId, { decision: "allow" });
      if (event.type === "approval.decided") fixture.svc.cancelSession(fixture.conversation.id);
    });
    const items = await fixture.run();
    expect(executions).toBe(0);
    expect(results(items).find((item) => item.parentCallId)?.annotations?.approval).toMatchObject({
      decision: "allow",
    });
    expect(results(items)).toHaveLength(calls(items).length);
  });

  it("keeps simultaneous approvals correlated and releases all pending requests on cancellation", async () => {
    for (const cancel of [false, true]) {
      const proposed = gate();
      const executions: number[] = [];
      const pending: { id: string; callId: string; value: number }[] = [];
      const operation: Tool = {
        name: "reviewed",
        description: "Reviewed operation",
        input: { kind: "function", schema: z.strictObject({ value: z.number() }) },
        execute: async (args) => {
          executions.push((args as { value: number }).value);
          return okResult("executed");
        },
      };
      const fixture = await setup(
        [
          evalStep(
            'return await Promise.allSettled([tools.call("reviewed", {value:1}), tools.call("reviewed", {value:2})]);',
          ),
          textStep("done"),
        ],
        [operation],
        "code-only",
        { approval: { outOfWorkspace: "allow", tools: { reviewed: "ask" } } },
      );
      fixture.svc.subscribe((event) => {
        if (
          isKernelEvent(event) &&
          event.type === "request.created" &&
          isApprovalRequest(event.request)
        ) {
          pending.push({
            id: event.requestId,
            callId: event.request.call.callId,
            value: (event.request.call.args as { value: number }).value,
          });
          expect(event.request.call.parentCallId).toBe("outer");
          if (pending.length === 2) proposed.resolve();
        }
      });
      const running = fixture.run();
      await proposed.promise;
      expect(executions).toEqual([]);
      if (cancel) await fixture.svc.deliver(fixture.conversation.id, "", "interrupt");
      else
        for (const request of pending)
          fixture.svc.respond(fixture.conversation.id, request.id, {
            decision: request.value === 1 ? "allow" : "deny",
          });
      const items = await running;
      expect(executions).toEqual(cancel ? [] : [1]);
      expect(results(items)).toHaveLength(calls(items).length);
      const outer = results(items).find((item) => item.callId === "outer")!;
      for (const request of pending) {
        const result = results(items).find((item) => item.callId === request.callId)!;
        expect(result.seq).toBeLessThan(outer.seq);
        expect(result.status).toBe(!cancel && request.value === 1 ? "ok" : "error");
      }
      expect(
        fixture.events.filter(isKernelEvent).filter((event) => event.type === "request.resolved"),
      ).toHaveLength(2);
    }
  });

  it("preserves deferred exposure and discovery output contracts through an escalating wrapper", async () => {
    class DeferredExecutionTool implements Tool {
      readonly name = "deferred_execution";
      readonly description = "Deferred execution fixture";
      readonly input = { kind: "function" as const, schema: z.strictObject({}) };
      readonly exposure = { direct: false, code: true };
      readonly outputSchema = { type: "string" };
      async execute() {
        return { ...okResult(this.name), structured: this.name };
      }
    }
    const sandbox = new LocalExecutionContext(null);
    const escaping = Object.assign(sandbox, { unconfined: new LocalExecutionContext(null) });
    const fixture = await setup(
      [
        toolStep("search-wrapper", "tool_search", { queries: ["deferred_execution"] }),
        toolStep("describe-wrapper", "tool_describe", { name: "deferred_execution" }),
        toolStep("guess-wrapper", "deferred_execution", {}),
        evalStep('return await tools.call("deferred_execution", {});'),
        textStep("done"),
      ],
      [executionFunctionTool(escaping, new DeferredExecutionTool())],
      "hybrid",
    );
    const items = await fixture.run();
    expect(discoveryOutput(items, "search-wrapper").tools[0]!.outputSchema).toEqual({
      type: "string",
    });
    const described = JSON.parse(
      textOf(results(items).find((item) => item.callId === "describe-wrapper")!.content),
    ) as ToolContract;
    expect(described.outputSchema).toEqual({ type: "string" });
    expect(
      fixture.requests.every(
        (request) => !request.tools?.some((tool) => tool.name === "deferred_execution"),
      ),
    ).toBe(true);
    expect(results(items).find((item) => item.callId === "guess-wrapper")!.status).toBe("error");
    expect(textOf(results(items).find((item) => item.callId === "outer")!.content)).toBe(
      '"deferred_execution"',
    );
  });

  it("routes escalation for one computed operation and returns its sibling to the configured backend", async () => {
    class ControlledSandbox extends LocalExecutionContext {
      readonly unconfined = new LocalExecutionContext(null);
      override classify(call: import("@harness/protocol").ToolCall) {
        return executionEscalationOf(call.args)
          ? ("out-of-workspace" as const)
          : ("in-workspace" as const);
      }
    }
    const sandbox = new ControlledSandbox(null);
    const routes: string[] = [];
    const tool = executionFunctionTool(sandbox, {
      name: "managed",
      description: "managed operation",
      input: { kind: "function", schema: z.strictObject({}) },
      execute: async (_args, ctx) => {
        routes.push(
          executionOf(ctx) === sandbox
            ? "configured"
            : executionOf(ctx) === sandbox.unconfined
              ? "host"
              : "wrong",
        );
        return okResult("done");
      },
    });
    let deniedExecutions = 0;
    const denied: Tool = {
      name: "blocked",
      description: "blocked",
      input: { kind: "function", schema: z.strictObject({}) },
      execute: async () => {
        deniedExecutions++;
        return okResult("bad");
      },
    };
    const execution: Plugin = {
      id: "controlled-execution",
      services: () => [{ key: "execution", for: () => sandbox }],
    };
    const fixture = await setup(
      [
        evalStep(
          'await tools.call("managed", {}); await tools.call("managed", {sandbox_permissions:"require_escalated",justification:"explicit operation"}); try {await tools.call("blocked", {});} catch {} return await tools.call("managed", {});',
        ),
        textStep("done"),
      ],
      [tool, denied],
      "code-only",
      { approval: { inWorkspace: "allow", outOfWorkspace: "ask", tools: { blocked: "deny" } } },
      { execution },
    );
    fixture.svc.subscribe((event) => {
      if (isKernelEvent(event) && event.type === "request.created")
        fixture.svc.respond(fixture.conversation.id, event.requestId, { decision: "allow" });
    });
    const items = await fixture.run();
    expect(routes).toEqual(["configured", "host", "configured"]);
    expect(deniedExecutions).toBe(0);
    expect(
      results(items)
        .filter((item) => item.parentCallId)
        .map((item) => item.status),
    ).toEqual(["ok", "ok", "error", "ok"]);
  });

  it("accepts a representative eight-file aggregate and rejects oversized ordinary discovery", async () => {
    const fixture = await setup([
      evalStep(
        'const {paths} = await tools.call("glob", {pattern:"*.txt"}); return (await Promise.all(paths.map(path => tools.call("read_file", {path})))).map(file => file.text.length);',
      ),
      toolStep("query", "tool_search", { queries: ["x ".repeat(500000)] }),
      textStep("done"),
    ]);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeFile(join(fixture.root, `${i}.txt`), `${"x".repeat(127)}\n`.repeat(256)),
      ),
    );
    const items = await fixture.run();
    expect(textOf(results(items).find((item) => item.callId === "outer")!.content)).toBe(
      JSON.stringify(Array(8).fill(32768)),
    );
    expect(textOf(results(items).find((item) => item.callId === "query")!.content)).toContain(
      "512",
    );
  });

  it("gives reviewers bounded structured evidence from spilled results", async () => {
    const lookup: Tool = {
      name: "lookup",
      description: "lookup",
      input: { kind: "function", schema: z.strictObject({}) },
      execute: async () => ({
        ...okResult("lookup complete"),
        structured: { authorizedId: 42, padding: "x".repeat(100000), tail: "end evidence" },
      }),
    };
    const update: Tool = {
      name: "update",
      description: "update",
      input: { kind: "function", schema: z.strictObject({ id: z.number() }) },
      execute: async () => okResult("updated"),
    };
    const fixture = await setup(
      [
        evalStep(
          'const found=await tools.call("lookup",{}); return await tools.call("update",{id:found.authorizedId});',
        ),
        textStep("YES"),
        textStep("done"),
      ],
      [lookup, update],
      "code-only",
      {
        approval: { outOfWorkspace: "allow", tools: { update: "ask" } },
        "auto-approval": { enabled: true },
      },
    );
    await fixture.run();
    const review = JSON.stringify(fixture.requests[1]);
    expect(review).toContain("authorizedId");
    expect(review).toContain("end evidence");
    expect(review).toContain("structured JSON preview");
    expect(review.length).toBeLessThan(15000);
  });

  it("round-trips nested associations and output references through public RPC and a reopened SQLite store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-code-store-"));
    roots.push(directory);
    const path = join(directory, "store.db");
    let store = new SqliteStore(path);
    const full = await store.putBlob(Buffer.from("full output"));
    const data: Tool = {
      name: "data",
      description: "data",
      input: { kind: "function", schema: z.strictObject({ large: z.boolean() }) },
      execute: async (args) => ({
        ...okResult("presentation"),
        structured: (args as { large: boolean }).large ? "x".repeat(100000) : null,
        full,
      }),
    };
    const fixture = await setup(
      [
        evalStep(
          'return [await tools.call("data", {large:false}), (await tools.call("data", {large:true})).length];',
        ),
        textStep("done"),
      ],
      [data],
      "code-only",
      {},
      { store },
    );
    const connections = createInProcessMessageConnectionPair();
    const host = new HarnessRpcHost(fixture.svc);
    const session = new HarnessRpcSession({
      connection: connections.right,
      host,
      server: { name: "test", version: "1" },
    });
    const client = new HarnessClient({
      connection: connections.left,
      client: { name: "test", version: "1" },
    });
    session.start();
    try {
      await client.start();
      await client.attach(fixture.conversation.id);
      await client.deliver(fixture.conversation.id, "task", "send");
      await fixture.svc.whenIdle(fixture.conversation.id);
      const history = await client.history({ conversationId: fixture.conversation.id });
      const items = await Promise.all(
        history.entries.map(async (entry) =>
          decodeItem(
            entry.kind === "item"
              ? entry.item
              : await client.readItem(fixture.conversation.id, entry),
          ),
        ),
      );
      items.sort((a, b) => a.seq - b.seq);
      const nested = results(items).filter((item) => item.parentCallId);
      expect(nested).toHaveLength(2);
      expect(nested[0]!.structured).toBeNull();
      expect(nested[0]!.full).toEqual(full);
      expect(nested[1]!.structuredRef?.bytes).toBeGreaterThan(100000);
      expect(
        calls(items)
          .filter((item) => item.parentCallId)
          .map((item) => item.callId),
      ).toEqual(nested.map((item) => item.callId));
      await session.shutdown();
      await host.shutdown();
      client.closeConnection();
      store.close();
      store = new SqliteStore(path);
      expect(
        results(await store.listActiveItems(fixture.conversation.id)).filter(
          (item) => item.parentCallId,
        ),
      ).toEqual(nested);
      expect(
        JSON.parse(Buffer.from(await store.getBlob(nested[1]!.structuredRef!)).toString()),
      ).toHaveLength(100000);
      const turn = await store.createTurn(fixture.conversation.id);
      await store.appendItem({
        conversationId: fixture.conversation.id,
        turnId: turn.id,
        type: "tool_call",
        callId: "crashed-child",
        parentCallId: "outer",
        name: "data",
        args: { large: false },
      });
      await reconcileConversation(store, fixture.conversation.id);
      const repaired = results(await store.listActiveItems(fixture.conversation.id)).at(-1)!;
      expect(repaired).toMatchObject({
        callId: "crashed-child",
        parentCallId: "outer",
        status: "error",
      });
      await reconcileConversation(store, fixture.conversation.id);
      expect(
        results(await store.listActiveItems(fixture.conversation.id)).filter(
          (item) => item.callId === "crashed-child",
        ),
      ).toHaveLength(1);
    } finally {
      await host.shutdown();
      await session.shutdown();
      client.closeConnection();
      sessions.splice(
        sessions.findIndex((entry) => entry.svc === fixture.svc),
        1,
      );
      store.close();
    }
  });
});

describe("portable eval and patch input", () => {
  it.each([false, true])("executes eval with custom support=%s", async (supported) => {
    const code = 'return { value: "quoted\\ntext" };';
    const options = { customToolInput: { supported, grammars: [] } };
    const fixture = await setup(
      [toolStep("eval-first", "eval", supported ? code : { code }), textStep("done")],
      [],
      "hybrid",
      {},
      options,
    );
    const items = await fixture.run();
    expect(results(items).find((item) => item.callId === "eval-first")?.status).toBe("ok");
    expect(fixture.requests[0]!.tools!.find((tool) => tool.name === "eval")!.kind).toBe(
      supported ? "custom" : "function",
    );
    expect(calls(items).find((item) => item.callId === "eval-first")?.args).toEqual(
      supported ? code : { code },
    );
  });
  it("keeps JSON patch execution and middleware text identical", async () => {
    const patch = "*** Begin Patch\n*** Add File: portable.txt\n+hello\n*** End Patch";
    const fixture = await setup(
      [toolStep("patch-json", "apply_patch", { patch }), textStep("done")],
      [],
      "hybrid",
      {},
      { preferredEditTool: "patch" },
    );
    const items = await fixture.run();
    expect(results(items).find((item) => item.callId === "patch-json")?.status).toBe("ok");
    expect(await readFile(join(fixture.root, "portable.txt"), "utf8")).toBe("hello");
    expect(calls(items).find((item) => item.callId === "patch-json")?.args).toEqual({ patch });
    expect(fixture.requests[0]!.tools!.find((tool) => tool.name === "apply_patch")!.kind).toBe(
      "function",
    );
  });
});

describe("model switches and JSON patch approvals", () => {
  it("switches raw to JSON to raw without rewriting calls or confusing history encoding", async () => {
    const raw = "return 'first';";
    const json = "return 'second';";
    const fixture = await setup(
      [
        toolStep("eval-a", "eval", raw),
        textStep("a done"),
        toolStep("eval-b", "eval", { code: json }),
        textStep("b done"),
        toolStep("eval-c", "eval", "return 'third';"),
        textStep("c done"),
      ],
      [],
      "hybrid",
      {},
      {
        modelCapabilities: {
          "fake-1": {
            customToolInput: { supported: true, grammars: ["lark"] },
            preferredEditTool: "patch",
          },
          "fake-json": {
            customToolInput: { supported: false, grammars: [] },
            preferredEditTool: "replace",
          },
        },
      },
    );
    await fixture.run();
    await fixture.svc.setModel(fixture.conversation.id, { provider: "fake", model: "fake-json" });
    await fixture.run();
    await fixture.svc.setModel(fixture.conversation.id, { provider: "fake", model: "fake-1" });
    const items = await fixture.run();
    for (const request of fixture.requests) {
      const plaintext = request.modelConfig.model === "fake-1";
      expect(request.tools!.find((tool) => tool.name === "eval")!.kind).toBe(
        plaintext ? "custom" : "function",
      );
      expect(request.tools!.some((tool) => tool.name === "apply_patch")).toBe(plaintext);
      expect(request.tools!.some((tool) => tool.name === "edit")).toBe(!plaintext);
      const native = buildResponseParams(request, undefined, "fake", false);
      const input = native.input;
      if (!Array.isArray(input)) throw new Error("Expected native item history");
      if (plaintext) {
        const structured = input.find(
          (entry) =>
            typeof entry === "object" &&
            "type" in entry &&
            entry.type === "function_call" &&
            entry.call_id === "eval-b",
        );
        if (
          request.items.some(({ item }) => item.type === "tool_call" && item.callId === "eval-b")
        ) {
          expect(structured).toMatchObject({ arguments: JSON.stringify({ code: json }) });
        }
      } else {
        expect(
          input.some(
            (entry) =>
              typeof entry === "object" && "type" in entry && entry.type === "custom_tool_call",
          ),
        ).toBe(false);
      }
    }
    expect(calls(items).map((item) => item.args)).toEqual([raw, { code: json }, "return 'third';"]);
    expect(results(items).every((item) => item.status === "ok")).toBe(true);
  });

  it.each(["allow", "deny"] as const)(
    "keeps JSON patch approval arguments and schema consistent on %s",
    async (decision) => {
      class ControlledSandbox extends LocalExecutionContext {
        readonly unconfined: LocalExecutionContext;
        constructor(root: string) {
          super(root);
          this.unconfined = new LocalExecutionContext(root);
        }
        override classify(call: import("@harness/protocol").ToolCall) {
          return executionEscalationOf(call.args)
            ? ("out-of-workspace" as const)
            : ("in-workspace" as const);
        }
      }
      const execution: Plugin = {
        id: "patch-execution",
        services: () => [
          {
            key: "execution",
            for: (conversation) => new ControlledSandbox(conversation.workspaceRoot!),
          },
        ],
      };
      const body = "*** Begin Patch\n*** Add File: nested/approved.txt\n+hello\n*** End Patch";
      const patch =
        "sandbox_permissions=require_escalated\njustification=explicit patch\n---\n" + body;
      const fixture = await setup(
        [toolStep("approval-patch", "apply_patch", { patch }), textStep("done")],
        [],
        "hybrid",
        { approval: { inWorkspace: "allow", outOfWorkspace: "ask" } },
        { preferredEditTool: "patch", execution },
      );
      await mkdir(join(fixture.root, "nested"));
      await writeFile(join(fixture.root, "nested/AGENTS.md"), "Nested portable patch instruction");
      const approvals: unknown[] = [];
      fixture.svc.subscribe((event) => {
        if (
          isKernelEvent(event) &&
          event.type === "request.created" &&
          isApprovalRequest(event.request)
        ) {
          approvals.push(event.request);
          fixture.svc.respond(fixture.conversation.id, event.requestId, { decision });
        }
      });
      const items = await fixture.run();
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        call: { name: "apply_patch", args: patch },
        input: { kind: "custom", name: "apply_patch" },
        relationship: "out-of-workspace",
      });
      expect(calls(items)[0]!.args).toEqual({ patch });
      expect(results(items).find((item) => item.callId === "approval-patch")!.status).toBe(
        decision === "allow" ? "ok" : "error",
      );
      if (decision === "allow") {
        expect(await readFile(join(fixture.root, "nested/approved.txt"), "utf8")).toBe("hello");
        expect(
          items.some(
            (item) =>
              item.type === "context" &&
              textOf(item.content).includes("Nested portable patch instruction"),
          ),
        ).toBe(true);
      } else {
        await expect(readFile(join(fixture.root, "nested/approved.txt"))).rejects.toThrow();
      }
    },
  );
});
