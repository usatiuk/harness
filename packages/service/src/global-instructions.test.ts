import { requestGuidance } from "@harness/testkit";
import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentsPlugin } from "@harness/agents";
import { approvalPlugin } from "@harness/approval";
import { DEFAULT_AGENTS, SubagentsDefinition } from "@harness/subagents";
import { activitiesPlugin } from "@harness/activities";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, textStep, unusedCodeEvaluator } from "@harness/testkit";
import {
  textOf,
  type ConversationId,
  type ModelProvider,
  type ModelRequest,
} from "@harness/protocol";
import { HarnessService } from "./service.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-global-instructions-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "server-home");
  const project = join(root, "unrelated-project");
  await mkdir(home);
  await mkdir(project);
  await writeFile(join(home, "AGENTS.md"), "PERSONAL GLOBAL RULES");
  await writeFile(join(project, "AGENTS.md"), "PROJECT RULES");
  return { home, project, root };
}

function runtime(home: string) {
  const requests: ModelRequest[] = [];
  const byConversation = new Map<ConversationId, ModelRequest>();
  const fake = new FakeProvider([]);
  const provider: ModelProvider = {
    provider: "fake",
    capabilities: () => fake.capabilities(),
    validateConfig: () => {},
    listModels: () => [],
    async *stream(request, _signal, context) {
      byConversation.set(context.conversationId, request);
      requests.push(request);
      yield* textStep("Finished");
    },
  };
  const subagents = new SubagentsDefinition((): HarnessService => service);
  const service = new HarnessService({
    home,
    store: new InMemoryStore(),
    codeEvaluator: unusedCodeEvaluator,
    plugins: [
      { id: "fake", providers: () => [provider] },
      activitiesPlugin,
      subagents,
      approvalPlugin,
      createAgentsPlugin(home),
    ],
    defaults: { model: { provider: "fake", model: "fake-1" } },
  });
  const roots: ConversationId[] = [];
  cleanups.push(async () => {
    for (const id of roots) await service.deactivateSession(id, { force: true });
  });
  return {
    service,
    requests,
    byConversation,
    subagents,
    createRoot: async (options: Parameters<HarnessService["createConversation"]>[0] = {}) => {
      const conversation = await service.createConversation(options);
      roots.push(conversation.id);
      return conversation;
    },
  };
}

it.each([true, false])(
  "adds global guidance to root and actual child role requests (workspace: %s)",
  async (workspace) => {
    const { home, project } = await fixture();
    const { service, requests, byConversation, subagents, createRoot } = runtime(home);
    const roles = [
      ...DEFAULT_AGENTS,
      { name: "custom", description: "Custom", systemPrompt: "CUSTOM ROLE" },
    ];
    const root = await createRoot({
      ...(workspace ? { cwd: project } : {}),
      overrides: { instructions: "ROOT ROLE", plugins: { subagents: { agents: roles } } },
    });
    await service.send(root.id, "root task");
    await service.whenIdle(root.id);
    expect(textOf(requestGuidance(requests[0]))).toContain("ROOT ROLE");
    for (const role of roles) {
      const activity = await subagents.spawn({
        parent: root.id,
        agent: role.name,
        name: `Inspect ${role.name}`,
        slug: `inspect-${role.name}`,
        task: "Inspect without modifying anything.",
      });
      await service.whenIdle(activity.childId);
      expect(textOf(requestGuidance(byConversation.get(activity.childId)))).toContain(
        role.systemPrompt,
      );
      expect(textOf(requestGuidance(byConversation.get(activity.childId)))).not.toContain(
        "ROOT ROLE",
      );
    }
    await service.whenIdle(root.id);
    for (const request of requests) {
      const instructions = textOf(requestGuidance(request));
      expect(instructions.match(/PERSONAL GLOBAL RULES/gu)).toHaveLength(1);
      expect(instructions.includes("PROJECT RULES")).toBe(workspace);
      if (workspace)
        expect(instructions.indexOf("PERSONAL GLOBAL RULES")).toBeLessThan(
          instructions.indexOf("PROJECT RULES"),
        );
    }
  },
);

it("isolates server homes and appends a changed global file once across reload", async () => {
  const { home, project, root } = await fixture();
  const otherHome = join(root, "other-server-home");
  await mkdir(otherHome);
  await writeFile(join(otherHome, "AGENTS.md"), "REMOTE SERVER RULES");
  const first = runtime(home);
  const second = runtime(otherHome);
  const conversation = await first.createRoot({ cwd: project });
  const remote = await second.createRoot({ cwd: project });
  await first.service.send(conversation.id, "first");
  await first.service.whenIdle(conversation.id);
  await writeFile(join(home, "AGENTS.md"), "UPDATED GLOBAL RULES");
  await first.service.send(conversation.id, "second");
  await first.service.whenIdle(conversation.id);
  expect(textOf(requestGuidance(first.requests.at(-1)))).toContain("PERSONAL GLOBAL RULES");
  expect(textOf(requestGuidance(first.requests.at(-1)))).toContain("UPDATED GLOBAL RULES");
  await first.service.deactivateSession(conversation.id);
  await first.service.prepare(conversation.id);
  await first.service.send(conversation.id, "after reload");
  await first.service.whenIdle(conversation.id);
  expect(textOf(requestGuidance(first.requests.at(-1)))).toContain("UPDATED GLOBAL RULES");
  await second.service.send(remote.id, "remote");
  await second.service.whenIdle(remote.id);
  const instructions = textOf(requestGuidance(second.requests[0]));
  expect(instructions).toContain("REMOTE SERVER RULES");
  expect(instructions).not.toContain("PERSONAL GLOBAL RULES");
  expect(instructions).not.toContain("UPDATED GLOBAL RULES");
});
