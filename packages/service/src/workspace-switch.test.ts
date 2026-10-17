import { QuickJsEvaluator } from "@harness/code-mode";
import { executionOf } from "@harness/execution";
import { Engine, PluginHost } from "@harness/core";
import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { InMemoryStore } from "@harness/store";
import { localExecutionPlugin } from "@harness/execution";
import { workspacePlugin } from "@harness/workspace";
import { agentsPlugin } from "@harness/agents";
import { approvalPlugin } from "@harness/approval";
import {
  unusedCodeEvaluator,
  FakeProvider,
  interleavedStep,
  textStep,
  toolStep,
} from "@harness/testkit";
import {
  isKernelEvent,
  okResult,
  textOf,
  type ModelRequest,
  type WorktreeOperations,
} from "@harness/protocol";
import { HarnessService } from "./service.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["hybrid", "code-only"] as const)(
  "%s switches only after a complete batch and refreshes directory-dependent instructions and tools",
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-switch-")));
    roots.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "file"), "first file");
    await writeFile(join(second, "file"), "second file");
    await writeFile(join(first, "AGENTS.md"), "FIRST GUIDANCE");
    await writeFile(join(second, "AGENTS.md"), "SECOND GUIDANCE");
    const resolving = gate();
    const readFinished = gate();
    const provider = new FakeProvider([
      mode === "code-only"
        ? toolStep("eval", "eval", {
            code: 'return await Promise.all([tools.call("switch_workspace", {}), tools.call("read_old", {})]);',
          })
        : interleavedStep([
            { callId: "switch", name: "switch_workspace", args: {} },
            { callId: "old", name: "read_file", args: { path: "file" } },
          ]),
      mode === "code-only"
        ? toolStep("next-eval", "eval", {
            code: 'return await tools.call("read_file", {path:"file"});',
          })
        : toolStep("new", "read_file", { path: "file" }),
      textStep("done"),
    ]);
    const requests: ModelRequest[] = [];
    const stream = provider.stream.bind(provider);
    const worktrees: WorktreeOperations = {
      repository: async (path) => path,
      inspect: async (path) => ({ path, branch: "test", head: "test", locked: false }),
      list: async () => {
        if (mode === "code-only") {
          resolving.resolve();
          await readFinished.promise;
        }
        return [{ path: second, branch: "test", head: "test", locked: false }];
      },
      create: async () => {
        throw new Error("not used");
      },
      validateRemoval: async () => {},
      managed: async () => [],
      remove: async () => {
        throw new Error("not used");
      },
    };
    const service = new HarnessService({
      store: new InMemoryStore(),
      home: join(root, "home"),
      worktrees,
      codeEvaluator: new QuickJsEvaluator(),
      plugins: [
        {
          id: "fake",
          providers: () => [
            {
              ...provider,
              provider: "fake",
              capabilities: provider.capabilities.bind(provider),
              validateConfig: provider.validateConfig.bind(provider),
              listModels: () => [],
              stream: (request) => {
                requests.push(request);
                return stream();
              },
            },
          ],
          tools: () => [
            {
              name: "read_old",
              description: "read during target resolution",
              input: { kind: "function", schema: z.object({}) },
              execute: async (_, ctx) => {
                await resolving.promise;
                try {
                  return okResult(new TextDecoder().decode(await executionOf(ctx).read("file")));
                } finally {
                  readFinished.resolve();
                }
              },
            },
            {
              name: "switch_workspace",
              essential: true,
              description: "switch",
              input: { kind: "function", schema: z.object({}) },
              execute: async (_, ctx) => {
                await service.selectWorkspace(
                  ctx.conversationId,
                  { kind: "existing", path: second },
                  true,
                );
                return okResult("scheduled");
              },
            },
          ],
        },
        localExecutionPlugin,
        workspacePlugin,
        approvalPlugin,
        agentsPlugin,
      ],
      defaults: { model: { provider: "fake", model: "fake-1" }, tools: { mode } },
    });
    service.subscribe((event) => {
      if (isKernelEvent(event) && event.type === "request.created")
        service.respond(event.conversationId, event.requestId, { decision: "allow" });
    });
    const conversation = await service.createConversation({ cwd: first });
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);
    const items = await service.getItems(conversation.id);
    expect(
      items.filter((item) => item.type === "tool_result").map((item) => textOf(item.content)),
    ).toEqual(
      mode === "hybrid"
        ? [
            "scheduled",
            expect.stringContaining("first file"),
            expect.stringContaining("second file"),
          ]
        : expect.arrayContaining([
            "scheduled",
            "first file",
            expect.stringContaining("second file"),
          ]),
    );
    expect(textOf(requests[0]!.instructions)).toContain("FIRST GUIDANCE");
    expect(textOf(requests[1]!.instructions)).toContain("SECOND GUIDANCE");
    expect(textOf(requests[1]!.instructions)).not.toContain("FIRST GUIDANCE");
    expect(await service.getConversation(conversation.id)).toMatchObject({
      workspaceRoot: second,
      originalWorkspaceRoot: first,
    });
  },
);

it("preserves a switched workspace when an overlapping settings resolution finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-switch-config-"));
  roots.push(root);
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const store = new InMemoryStore();
  const record = await store.createConversation({ workspaceRoot: first, overrides: {} });
  let blocked = false;
  const entered = gate();
  const release = gate();
  const engine = new Engine(
    store,
    new PluginHost([localExecutionPlugin]),
    async (record) => {
      if (blocked) {
        entered.resolve();
        await release.promise;
      }
      return {
        instructions: "",
        model: { provider: "fake", model: "fake" },
        plugins: (record.overrides.plugins as Record<string, unknown>) ?? {},
      };
    },
    unusedCodeEvaluator,
  );
  await engine.prepare(record.id);
  blocked = true;
  const updating = engine.updatePluginOverrides(record.id, { test: { enabled: true } });
  await entered.promise;
  await engine.switchWorkspace(record.id, async () => second);
  release.resolve();
  await updating;
  expect((await store.getConversation(record.id))?.workspaceRoot).toBe(second);
  expect(engine.conversationTreeState(record.id)[0]?.conversation.workspaceRoot).toBe(second);
  expect(engine.serviceFor(record.id, "execution")).toMatchObject({ workspaceRoot: second });
  expect(engine.configFor(record.id)?.plugins?.test).toEqual({ enabled: true });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("reserves source during Git preparation and aborts it on forced close", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-switch-reservation-"));
  roots.push(root);
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const store = new InMemoryStore();
  const record = await store.createConversation({ workspaceRoot: first, overrides: {} });
  const engine = new Engine(
    store,
    new PluginHost([localExecutionPlugin]),
    async () => ({
      instructions: "",
      model: { provider: "fake", model: "fake" },
    }),
    unusedCodeEvaluator,
  );
  const entered = gate();
  let signal: AbortSignal | undefined;
  const switching = engine.switchWorkspace(record.id, (operationSignal) => {
    signal = operationSignal;
    entered.resolve();
    return new Promise((_, reject) =>
      operationSignal.addEventListener(
        "abort",
        () => reject(new Error("Workspace selection aborted")),
        {
          once: true,
        },
      ),
    );
  });
  const rejected = expect(switching).rejects.toThrow();
  await entered.promise;
  await expect(engine.deleteWorkspace(first, async () => {})).rejects.toThrow("Stop conversations");
  await expect(engine.switchWorkspace(record.id, async () => second)).rejects.toThrow(
    "already pending",
  );
  await engine.deactivate(record.id, { force: true });
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect((await store.getConversation(record.id))?.workspaceRoot).toBe(first);
});

it("excludes administrative workspace preparation from deletion in both directions", async () => {
  const store = new InMemoryStore();
  const engine = new Engine(
    store,
    new PluginHost([]),
    async () => ({
      instructions: "",
      model: { provider: "fake", model: "fake" },
    }),
    unusedCodeEvaluator,
  );
  const started = gate();
  const release = gate();
  const operation = engine.runWorkspaceOperation("/project", async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  await expect(engine.deleteWorkspace("/project", async () => {})).rejects.toThrow(
    "preparation is in progress",
  );
  release.resolve();
  await operation;
  await engine.deleteWorkspace("/project", async () => {
    await expect(
      engine.runWorkspaceOperation("/project/subfolder", async () => {}),
    ).rejects.toThrow("deletion is in progress");
  });
});
