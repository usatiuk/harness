import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKernelEvent, type HarnessEvent } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, textStep, toolStep } from "@harness/testkit";
import { localExecutionPlugin } from "@harness/execution";
import { activitiesPlugin } from "@harness/activities";
import { workspacePlugin } from "@harness/workspace";
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

function service(steps: ReturnType<typeof toolStep>[], onRequest?: (id: string) => unknown) {
  const store = new InMemoryStore();
  const svc = new HarnessService({
    store,
    home: "/nonexistent-harness-home",
    plugins: [
      { id: "fake", providers: () => [new FakeProvider(steps)] },
      localExecutionPlugin,
      activitiesPlugin,
      workspacePlugin,
      approvalPlugin,
    ],
  });
  const events: HarnessEvent[] = [];
  svc.subscribe((event) => {
    events.push(event);
    if (isKernelEvent(event) && event.type === "request.created" && onRequest) {
      svc.respond(event.conversationId, event.requestId, onRequest(event.requestId));
    }
  });
  return { svc, events };
}

const overrides = { instructions: "go", model: { provider: "fake", model: "fake-1" } };
const commandTool = process.platform === "win32" ? "powershell" : "bash";

describe("execution + approval pipeline", () => {
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
