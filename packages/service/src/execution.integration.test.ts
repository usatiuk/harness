import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isKernelEvent,
  textOf,
  type HarnessEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, fakeCompaction, textStep, toolStep } from "@harness/testkit";
import { localExecutionPlugin } from "@harness/execution";
import { activitiesPlugin } from "@harness/activities";
import { workspacePlugin } from "@harness/workspace";
import { agentsPlugin } from "@harness/agents";
import { approvalPlugin, approvalAnnotationOf } from "@harness/approval";
import { HarnessService } from "./service.ts";

const created: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hsvc-"));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

class RecordingProvider implements ModelProvider {
  readonly provider = "fake";
  readonly requests: ModelRequest[] = [];
  readonly #inner: FakeProvider;

  constructor(steps: ReturnType<typeof toolStep>[]) {
    this.#inner = new FakeProvider(steps);
  }

  capabilities() {
    return this.#inner.capabilities();
  }
  validateConfig(): void {}
  listModels(): ModelInfo[] {
    return [];
  }
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    void signal;
    return this.#inner.stream();
  }
}

function service(
  steps: ReturnType<typeof toolStep>[],
  onRequest?: (id: string) => unknown,
  store = new InMemoryStore(),
) {
  const provider = new RecordingProvider(steps);
  const svc = new HarnessService({
    store,
    home: "/nonexistent-harness-home",
    plugins: [
      { id: "fake", providers: () => [provider] },
      localExecutionPlugin,
      activitiesPlugin,
      workspacePlugin,
      approvalPlugin,
      agentsPlugin,
      { id: "test-compaction", policies: () => ({ compaction: fakeCompaction({ over: 0 }) }) },
    ],
  });
  const events: HarnessEvent[] = [];
  svc.subscribe((event) => {
    events.push(event);
    if (isKernelEvent(event) && event.type === "request.created" && onRequest) {
      svc.respond(event.conversationId, event.requestId, onRequest(event.requestId));
    }
  });
  return { svc, events, provider, store };
}

const overrides = { instructions: "go", model: { provider: "fake", model: "fake-1" } };
const commandTool = process.platform === "win32" ? "powershell" : "bash";

describe("execution + approval pipeline", () => {
  it("loads initial and nested AGENTS.md instructions through a real file-tool turn", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "AGENTS.md"), "root guidance");
    await writeFile(join(root, "src", "AGENTS.md"), "nested guidance");
    await writeFile(join(root, "src", "a.txt"), "hello");
    const { svc, provider } = service([
      toolStep("c1", "read_file", { path: "src/a.txt" }),
      toolStep("c2", "read_file", { path: "src/a.txt" }),
      textStep("done"),
    ]);
    const conv = await svc.createConversation({ cwd: root, overrides });

    await svc.send(conv.id, "go");
    await svc.whenIdle(conv.id);

    expect(textOf(provider.requests[0]!.instructions)).toContain("root guidance");
    expect(
      provider.requests[1]!.items.some(
        ({ item }) => item.type === "context" && textOf(item.content).includes("nested guidance"),
      ),
    ).toBe(true);
    const contexts = (await svc.getItems(conv.id)).filter((item) => item.type === "context");
    expect(contexts).toHaveLength(1);
    const items = await svc.getItems(conv.id);
    expect(items.findIndex((item) => item.type === "context")).toBeGreaterThan(
      items.findIndex((item) => item.type === "tool_result"),
    );
  });

  it("snapshots initial instructions independently for each conversation cwd", async () => {
    const root = await workspace();
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "AGENTS.md"), "first guidance");
    await writeFile(join(second, "AGENTS.md"), "second guidance");
    const { svc, provider } = service([textStep("first done"), textStep("second done")]);
    const firstConversation = await svc.createConversation({ cwd: first, overrides });
    const secondConversation = await svc.createConversation({ cwd: second, overrides });

    await svc.send(firstConversation.id, "go");
    await svc.whenIdle(firstConversation.id);
    await svc.send(secondConversation.id, "go");
    await svc.whenIdle(secondConversation.id);

    expect(textOf(provider.requests[0]!.instructions)).toContain("first guidance");
    expect(textOf(provider.requests[0]!.instructions)).not.toContain("second guidance");
    expect(textOf(provider.requests[1]!.instructions)).toContain("second guidance");
    expect(textOf(provider.requests[1]!.instructions)).not.toContain("first guidance");
  });

  it("takes a fresh initial snapshot when a conversation resumes in a new service", async () => {
    const root = await workspace();
    const instructions = join(root, "AGENTS.md");
    await writeFile(instructions, "version one");
    const first = service([textStep("first done")]);
    const conv = await first.svc.createConversation({ cwd: root, overrides });
    await first.svc.send(conv.id, "go");
    await first.svc.whenIdle(conv.id);

    await writeFile(instructions, "version two");
    const resumed = service([textStep("second done")], undefined, first.store);
    await resumed.svc.send(conv.id, "continue");
    await resumed.svc.whenIdle(conv.id);

    expect(textOf(resumed.provider.requests[0]!.instructions)).toContain("version two");
    expect(textOf(resumed.provider.requests[0]!.instructions)).not.toContain("version one");
  });

  it("auto-runs an in-workspace write without prompting, and actually writes the file", async () => {
    const root = await workspace();
    const { svc, events } = service([
      toolStep("c1", "write", { path: "note.txt", content: "hello" }),
      textStep("done"),
    ]);
    const conv = await svc.createConversation({ cwd: root, overrides });

    await svc.send(conv.id, "go");
    await svc.whenIdle(conv.id);

    expect(events.some((e) => e.type === "request.created")).toBe(false);
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("hello");
    const completed = events.find((e) => e.type === "tool_call.completed");
    expect(completed && "status" in completed && completed.status).toBe("ok");
  });

  it("prompts for an out-of-workspace command and errors the call on deny", async () => {
    const root = await workspace();
    const { svc, events } = service(
      [toolStep("c1", commandTool, { command: "echo hi" }), textStep("done")],
      () => ({ decision: "deny" }),
    );
    const conv = await svc.createConversation({ cwd: root, overrides });

    await svc.send(conv.id, "go");
    await svc.whenIdle(conv.id);

    expect(events.some((e) => e.type === "request.created")).toBe(true);
    const completed = events.find((e) => e.type === "tool_call.completed");
    expect(completed && "status" in completed && completed.status).toBe("error");
    const result = (await svc.getItems(conv.id)).find((item) => item.type === "tool_result");
    expect(
      result?.type === "tool_result" && approvalAnnotationOf(result.annotations),
    ).toMatchObject({ decision: "deny", responder: "human" });
  });

  it("does not load instructions from an out-of-workspace file call denied by approval", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "AGENTS.md"), "must stay unread");
    await writeFile(join(outside, "secret.txt"), "secret");
    const { svc } = service([
      toolStep("c1", "read_file", { path: join(outside, "secret.txt") }),
      textStep("done"),
    ]);
    const conv = await svc.createConversation({
      cwd: root,
      overrides: {
        ...overrides,
        plugins: { approval: { tools: { read_file: "deny" } } },
      },
    });

    await svc.send(conv.id, "go");
    await svc.whenIdle(conv.id);

    expect((await svc.getItems(conv.id)).some((item) => item.type === "context")).toBe(false);
  });

  it("does not load nested instructions for invalid or unavailable file calls", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "AGENTS.md"), "must not load");
    const { svc } = service([
      toolStep("c1", "write", { path: "src/a.txt" }),
      toolStep("c2", "str_replace_based_edit_tool", { command: "view", path: "src/a.txt" }),
      textStep("done"),
    ]);
    const conv = await svc.createConversation({ cwd: root, overrides });

    await svc.send(conv.id, "go");
    await svc.whenIdle(conv.id);

    expect((await svc.getItems(conv.id)).some((item) => item.type === "context")).toBe(false);
  });

  it("reloads nested instructions after compaction removes their active marker", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    const instructions = join(root, "src", "AGENTS.md");
    await writeFile(instructions, "version one");
    await writeFile(join(root, "src", "a.txt"), "hello");
    const { svc, provider } = service([
      toolStep("c1", "read_file", { path: "src/a.txt" }),
      textStep("first done"),
      toolStep("c2", "read_file", { path: "src/a.txt" }),
      textStep("second done"),
    ]);
    const conv = await svc.createConversation({ cwd: root, overrides });

    await svc.send(conv.id, "first");
    await svc.whenIdle(conv.id);
    expect(await svc.compact(conv.id)).toBe("compacted");
    await writeFile(instructions, "version two");
    await svc.send(conv.id, "second");
    await svc.whenIdle(conv.id);

    const contexts = (await svc.getItems(conv.id)).filter((item) => item.type === "context");
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.type === "context" && textOf(contexts[1]!.content)).toContain(
      "version two",
    );
    expect(
      provider.requests
        .at(-1)!
        .items.some(
          ({ item }) => item.type === "context" && textOf(item.content).includes("version two"),
        ),
    ).toBe(true);
  });

  it("reloads nested instructions when continuing from before their marker after rewind", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    const instructions = join(root, "src", "AGENTS.md");
    await writeFile(instructions, "version one");
    await writeFile(join(root, "src", "a.txt"), "hello");
    const { svc } = service([
      toolStep("c1", "read_file", { path: "src/a.txt" }),
      textStep("first done"),
      toolStep("c2", "read_file", { path: "src/a.txt" }),
      textStep("second done"),
    ]);
    const conv = await svc.createConversation({ cwd: root, overrides });

    await svc.send(conv.id, "first");
    await svc.whenIdle(conv.id);
    const firstUser = (await svc.getItems(conv.id)).find(
      (item) => item.type === "message" && item.role === "user",
    )!;
    await svc.rewind(conv.id, firstUser.id);
    await writeFile(instructions, "version two");
    await svc.send(conv.id, "second");
    await svc.whenIdle(conv.id);

    const contexts = (await svc.getItems(conv.id)).filter((item) => item.type === "context");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.type === "context" && textOf(contexts[0]!.content)).toContain(
      "version two",
    );
  });

  it("runs an approved command as an activity and inlines its output", async () => {
    const root = await workspace();
    const { svc, events } = service(
      [toolStep("c1", commandTool, { command: "echo hi" }), textStep("done")],
      () => ({ decision: "allow" }),
    );
    const conv = await svc.createConversation({ cwd: root, overrides });

    await svc.send(conv.id, "go");
    await svc.whenIdle(conv.id);

    const completed = events.find((e) => e.type === "tool_call.completed");
    expect(completed && "status" in completed && completed.status).toBe("ok");
    expect(completed && "forModel" in completed && JSON.stringify(completed.forModel)).toContain(
      "hi",
    );
    const result = (await svc.getItems(conv.id)).find((item) => item.type === "tool_result");
    expect(
      result?.type === "tool_result" && approvalAnnotationOf(result.annotations),
    ).toMatchObject({ decision: "allow", responder: "human" });
  });

  it("persists a policy denial without creating a host approval request", async () => {
    const root = await workspace();
    const { svc, events } = service([
      toolStep("c1", commandTool, { command: "echo hi" }),
      textStep("done"),
    ]);
    const conv = await svc.createConversation({
      cwd: root,
      overrides: {
        ...overrides,
        plugins: { approval: { tools: { [commandTool]: "deny" } } },
      },
    });

    await svc.send(conv.id, "go");
    await svc.whenIdle(conv.id);

    expect(events.some((event) => event.type === "request.created")).toBe(false);
    const result = (await svc.getItems(conv.id)).find((item) => item.type === "tool_result");
    expect(
      result?.type === "tool_result" && approvalAnnotationOf(result.annotations),
    ).toMatchObject({ decision: "deny", responder: "policy" });
  });
});
