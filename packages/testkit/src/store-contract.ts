import { describe, expect, it } from "vitest";
import type { ConversationId, ItemId, NewItem, Store, TurnId } from "@harness/protocol";
import { newConversationInput } from "./conversation.ts";

const sampleRecord = () =>
  newConversationInput({
    instructions: "be helpful",
    model: { provider: "fake", model: "fake-1" },
    plugins: { demo: { level: "high" } },
  });

const message = (conversationId: ConversationId, turnId: TurnId, text: string): NewItem => ({
  conversationId,
  turnId,
  type: "message",
  role: "user",
  content: [{ type: "text", text }],
});

/**
 * Behavioral spec every Store impl must satisfy. Run it against the in-memory
 * store now and the sqlite store later — this is the "in-memory ≡ sqlite" proof.
 */
export function storeContract(name: string, makeStore: () => Store): void {
  describe(name, () => {
    it("forks before a user item with shared immutable ancestry and independent local records", async () => {
      const store = makeStore();
      const source = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(source.id);
      const first = await store.appendItem(message(source.id, turn.id, "first"));
      const selected = await store.appendItem(message(source.id, turn.id, "edit me"));
      const suffix = await store.appendItem(message(source.id, turn.id, "later"));
      const empty = await store.forkConversation(source.id, first.id, {
        model: { provider: "fake", model: "fake-1" },
      });
      expect(empty.head).toBeNull();
      expect(await store.listActiveItems(empty.id)).toEqual([]);
      const fork = await store.forkConversation(source.id, selected.id, source.overrides);
      expect(fork.head).toBe(first.id);
      expect(fork.fork).toEqual({ conversationId: source.id, userMessageId: selected.id });
      expect(await store.listOwnedItems(fork.id)).toEqual([]);
      expect(await store.listActiveItems(fork.id)).toEqual([first]);
      const forkTurn = await store.createTurn(fork.id);
      const edited = await store.appendItem(message(fork.id, forkTurn.id, "edited"));
      expect(edited.parent).toBe(first.id);
      expect(edited.seq).toBeGreaterThan(first.seq);
      expect(await store.listActiveItems(fork.id)).toEqual([first, edited]);
      expect(await store.listActiveItems(source.id)).toEqual([first, selected, suffix]);
      const nested = await store.forkConversation(fork.id, edited.id, fork.overrides);
      expect(await store.listActiveItems(nested.id)).toEqual([first]);
      expect((await store.listItemAncestors(edited.id, 1))[0]).toEqual(edited);
      expect((await store.listItemAncestors(edited.parent, 1))[0]).toEqual(first);
      await store.setHead(source.id, first.id);
      await store.appendItem(message(source.id, turn.id, "source branch"));
      expect(await store.listActiveItems(fork.id)).toEqual([first, edited]);
      expect(await store.getItem(selected.id)).toEqual(selected);
      expect((await store.summarizeModelUsage(fork.id)).usage.inputTokens).toBe(0);
    });

    it("fork validates the user target without checking its owner and does not create invalid forks", async () => {
      const store = makeStore();
      const source = await store.createConversation(sampleRecord());
      const other = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(other.id);
      const prefix = await store.appendItem(message(other.id, turn.id, "prefix"));
      const user = await store.appendItem(message(other.id, turn.id, "user"));
      const fork = await store.forkConversation(source.id, user.id, {});
      expect(await store.listActiveItems(fork.id)).toEqual([prefix]);
      const assistant = await store.appendItem({
        conversationId: other.id,
        turnId: turn.id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      });
      const before = (await store.listConversations()).length;
      await expect(store.forkConversation(source.id, assistant.id, {})).rejects.toThrow(
        "user message",
      );
      await expect(store.forkConversation(source.id, "missing" as ItemId, {})).rejects.toThrow(
        "user message",
      );
      expect((await store.listConversations()).length).toBe(before);
    });
    it("persists titles in reads and pages, and rejects stale title replacements", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      expect(conv.title).toBeNull();
      expect(await store.updateConversationTitle(conv.id, "first message", null)).toBe(true);
      expect(await store.updateConversationTitle(conv.id, "My title", "first message")).toBe(true);
      expect(
        await store.updateConversationTitle(conv.id, "late model title", "first message"),
      ).toBe(false);
      expect((await store.getConversation(conv.id))?.title).toBe("My title");
      expect((await store.listConversationPage(1))[0]?.title).toBe("My title");
      expect((await store.listConversations())[0]?.title).toBe("My title");
    });

    it("orders accepted-input recency before paging and filters folders without promoting child activity", async () => {
      const store = makeStore();
      const a = await store.createConversation({ ...sampleRecord(), workspaceRoot: "/a" });
      const b = await store.createConversation({ ...sampleRecord(), workspaceRoot: "/b" });
      const child = await store.createConversation({
        ...sampleRecord(),
        workspaceRoot: "/child-only",
      });
      await store.putPluginState("subagents", child.id, "spawn", { parent: a.id });
      const lastUsedAt = store.recordUserInput(a.id);
      expect((await store.getConversation(a.id))?.lastUsedAt).toBe(lastUsedAt);
      const options = {
        order: "lastUsed" as const,
        excludedState: { plugin: "subagents", key: "spawn" },
      };
      const first = await store.listConversationPage(1, undefined, options);
      expect(first.map((row) => row.id)).toEqual([a.id]);
      expect(
        (
          await store.listConversationPage(
            1,
            { lastUsedAt: first[0]!.lastUsedAt, id: a.id },
            options,
          )
        ).map((row) => row.id),
      ).toEqual([b.id]);
      expect(
        (await store.listConversationPage(5, undefined, { ...options, workspaceRoot: "/a" })).map(
          (row) => row.id,
        ),
      ).toEqual([a.id]);
      expect((await store.listConversationPage(5)).map((row) => row.id)).toEqual([
        child.id,
        b.id,
        a.id,
      ]);
      const projects = await store.listConversationProjects(1, undefined, options.excludedState);
      expect(projects.map((row) => row.workspaceRoot)).toEqual(["/a"]);
      expect(
        (await store.listConversationProjects(5, projects[0], options.excludedState)).map(
          (row) => row.workspaceRoot,
        ),
      ).toEqual(["/b"]);
    });

    it("groups worktree conversations with their original project before pagination while preserving workspace filters", async () => {
      const store = makeStore();
      const project = await store.createConversation({ ...sampleRecord(), workspaceRoot: "/repo" });
      await store.createConversation({ ...sampleRecord(), workspaceRoot: "/other" });
      const trees = [];
      for (let index = 0; index < 7; index++)
        trees.push(
          await store.createConversation({
            ...sampleRecord(),
            workspaceRoot: `/trees/${index}`,
            originalWorkspaceRoot: "/repo",
          }),
        );
      const child = await store.createConversation({
        ...sampleRecord(),
        workspaceRoot: "/trees/child",
        originalWorkspaceRoot: "/repo",
      });
      await store.putPluginState("subagents", child.id, "spawn", { parent: project.id });
      const lastUsedAt = store.recordUserInput(trees[0]!.id);
      const options = {
        order: "lastUsed" as const,
        projectRoot: "/repo",
        excludedState: { plugin: "subagents", key: "spawn" },
      };
      const first = await store.listConversationPage(3, undefined, options);
      const second = await store.listConversationPage(
        3,
        { lastUsedAt: first.at(-1)!.lastUsedAt, id: first.at(-1)!.id },
        options,
      );
      const third = await store.listConversationPage(
        3,
        { lastUsedAt: second.at(-1)!.lastUsedAt, id: second.at(-1)!.id },
        options,
      );
      expect([...first, ...second, ...third].map((row) => row.id)).toEqual([
        trees[0]!.id,
        ...trees
          .slice(1)
          .reverse()
          .map((row) => row.id),
        project.id,
      ]);
      const groups = await store.listConversationProjects(1, undefined, options.excludedState);
      expect(groups).toEqual([{ workspaceRoot: "/repo", lastUsedAt }]);
      expect(
        (await store.listConversationProjects(5, groups[0], options.excludedState)).map(
          (row) => row.workspaceRoot,
        ),
      ).toEqual(["/other"]);
      expect(
        (await store.listConversationPage(5, undefined, { workspaceRoot: "/repo" })).map(
          (row) => row.id,
        ),
      ).toEqual([project.id]);
      expect(
        (await store.listConversationPage(5, undefined, { workspaceRoot: "/trees/0" })).map(
          (row) => row.id,
        ),
      ).toEqual([trees[0]!.id]);
    });

    it("assigns monotonic per-conversation seq on append", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "hi"));
      const b = await store.appendItem(message(conv.id, turn.id, "yo"));
      expect([a.seq, b.seq]).toEqual([0, 1]);
      const items = await store.listOwnedItems(conv.id);
      expect(items.map((i) => i.seq)).toEqual([0, 1]);
    });

    it("listConversations returns every conversation, most-recent-first", async () => {
      const store = makeStore();
      const a = await store.createConversation(sampleRecord());
      const b = await store.createConversation(sampleRecord());
      const c = await store.createConversation(sampleRecord());
      expect((await store.listConversations()).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    });

    it("paginates conversations with an exclusive stable cursor", async () => {
      const store = makeStore();
      const a = await store.createConversation(sampleRecord());
      const b = await store.createConversation(sampleRecord());
      const c = await store.createConversation(sampleRecord());
      const first = await store.listConversationPage(2);
      expect(first.map((record) => record.id)).toEqual([c.id, b.id]);
      const second = await store.listConversationPage(2, {
        createdAt: b.createdAt,
        id: b.id,
      });
      expect(second.map((record) => record.id)).toEqual([a.id]);
    });

    it("updateConversationOverrides shallow-merges the patch and preserves the rest", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      await store.updateConversationOverrides(conv.id, {
        model: { provider: "fake", model: "fake-2" },
      });
      const updated = await store.getConversation(conv.id);
      expect(updated?.overrides.model).toEqual({ provider: "fake", model: "fake-2" });
      expect(updated?.overrides.instructions).toBe("be helpful");
      expect(updated?.overrides.plugins).toEqual({ demo: { level: "high" } });
    });

    it("updateConversationOverrides applies concurrent different-key patches without losing a write", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      // Both fire before either is awaited. A non-atomic read-modify-write would let the two patches
      // read the same base and the second clobber the first's key; an atomic merge keeps both.
      await Promise.all([
        store.updateConversationOverrides(conv.id, {
          model: { provider: "fake", model: "fake-2" },
        }),
        store.updateConversationOverrides(conv.id, { instructions: "be terse" }),
      ]);
      const updated = await store.getConversation(conv.id);
      expect(updated?.overrides.model).toEqual({ provider: "fake", model: "fake-2" });
      expect(updated?.overrides.instructions).toBe("be terse");
    });

    it("deleteConversationIfEmpty drops untouched conversations and spares used ones", async () => {
      const store = makeStore();
      const empty = await store.createConversation(sampleRecord());
      const used = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(used.id);
      await store.appendItem(message(used.id, turn.id, "hi"));

      // A conversation whose turn never appended (head still null) counts as in-use.
      const started = await store.createConversation(sampleRecord());
      await store.createTurn(started.id);

      await store.deleteConversationIfEmpty(empty.id);
      await store.deleteConversationIfEmpty(used.id);
      await store.deleteConversationIfEmpty(started.id);
      await store.deleteConversationIfEmpty("missing" as ConversationId); // no-op

      expect((await store.listConversations()).map((x) => x.id).sort()).toEqual(
        [used.id, started.id].sort(),
      );
    });

    it("links parent to the prior head and advances head on append", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      expect(conv.head).toBeNull();
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const b = await store.appendItem(message(conv.id, turn.id, "b"));
      expect(a.parent).toBeNull();
      expect(b.parent).toBe(a.id);
      expect((await store.getConversation(conv.id))?.head).toBe(b.id);
    });

    it("setHead moves head and listActiveItems follows the new lineage", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const b = await store.appendItem(message(conv.id, turn.id, "b"));
      expect((await store.listActiveItems(conv.id)).map((i) => i.id)).toEqual([a.id, b.id]);
      await store.setHead(conv.id, a.id);
      expect((await store.listActiveItems(conv.id)).map((i) => i.id)).toEqual([a.id]);
    });

    it("setHead accepts an existing item regardless of physical owner", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const other = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(other.id);
      const stray = await store.appendItem(message(other.id, turn.id, "x"));
      await store.setHead(conv.id, stray.id);
      expect(await store.listActiveItems(conv.id)).toEqual([stray]);
    });

    it("branches: the abandoned tail is off the active chain but kept in the raw log", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const abandoned = await store.appendItem(message(conv.id, turn.id, "abandoned"));
      await store.setHead(conv.id, a.id);
      const branched = await store.appendItem(message(conv.id, turn.id, "branched"));

      // The new item branches off `a`, not the abandoned tail.
      expect(branched.parent).toBe(a.id);
      expect(branched.seq).toBeGreaterThan(abandoned.seq); // seq keeps growing across the branch
      // Active chain skips the abandoned item; the raw log retains all three.
      expect((await store.listActiveItems(conv.id)).map((i) => i.id)).toEqual([a.id, branched.id]);
      expect((await store.listOwnedItems(conv.id)).map((i) => i.id)).toEqual([
        a.id,
        abandoned.id,
        branched.id,
      ]);
    });

    it("reads an anchored lineage newest-first in bounded pages", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const other = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const b = await store.appendItem(message(conv.id, turn.id, "b"));
      const c = await store.appendItem(message(conv.id, turn.id, "c"));

      expect((await store.listItemAncestors(c.id, 2)).map((item) => item.id)).toEqual([c.id, b.id]);
      expect((await store.listItemAncestors(b.parent, 2)).map((item) => item.id)).toEqual([a.id]);
      expect(await store.getItem("missing" as ItemId)).toBeUndefined();
      await store.setHead(other.id, b.id);
      expect(await store.listActiveItems(other.id)).toEqual([a, b]);
      expect(await store.getItem(b.id)).toEqual(b);
    });

    it("listOwnedItems honors a seq range", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      await store.appendItem(message(conv.id, turn.id, "a"));
      await store.appendItem(message(conv.id, turn.id, "b"));
      await store.appendItem(message(conv.id, turn.id, "c"));
      const mid = await store.listOwnedItems(conv.id, { fromSeq: 1, toSeq: 1 });
      expect(mid.map((i) => i.seq)).toEqual([1]);
    });

    it("round-trips a reasoning item", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const item = await store.appendItem({
        conversationId: conv.id,
        turnId: turn.id,
        type: "reasoning",
        content: [{ type: "text", text: "thinking" }],
      });
      const [stored] = await store.listOwnedItems(conv.id);
      expect(stored).toEqual(item);
      expect(stored?.type === "reasoning" && stored.content).toEqual([
        { type: "text", text: "thinking" },
      ]);
    });

    it("round-trips a context item, key intact, on the active chain", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const item = await store.appendItem({
        conversationId: conv.id,
        turnId: turn.id,
        type: "context",
        key: "agents-md:src/api/AGENTS.md",
        content: [{ type: "text", text: "project rules" }],
      });
      const [stored] = await store.listOwnedItems(conv.id);
      expect(stored).toEqual(item);
      expect(stored?.type === "context" && stored.key).toBe("agents-md:src/api/AGENTS.md");
      // it is on the active chain (the source the model build reads)
      expect(await store.listActiveItems(conv.id)).toEqual([item]);
    });

    it("round-trips namespaced tool-result annotations", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const item = await store.appendItem({
        conversationId: conv.id,
        turnId: turn.id,
        type: "tool_result",
        callId: "call-1",
        content: [{ type: "text", text: "ran" }],
        status: "ok",
        annotations: {
          approval: {
            decision: "allow",
            responder: "auto",
            relationship: "out-of-workspace",
          },
        },
      });
      expect((await store.listOwnedItems(conv.id))[0]).toEqual(item);
    });

    it("tracks at most one running turn", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      expect(await store.getActiveTurn(conv.id)).toEqual(turn);
      await expect(store.createTurn(conv.id)).rejects.toThrow();
      await store.updateTurn(turn.id, "completed");
      expect(await store.getActiveTurn(conv.id)).toBeUndefined();
      // a fresh turn is allowed once the previous one is no longer running
      await store.createTurn(conv.id);
    });

    it("round-trips provider payloads by itemId", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "x"));
      const b = await store.appendItem(message(conv.id, turn.id, "y"));
      const payload = {
        itemId: a.id,
        provider: "fake",
        model: "fake-1",
        type: "reasoning",
        version: 1,
        payload: { encrypted: "blob" },
      };
      await store.putProviderPayload(payload);
      expect(await store.getProviderPayloads([a.id])).toEqual([payload]);
      expect(await store.getProviderPayloads([b.id])).toEqual([]);
    });

    it("round-trips model usage rows in record order", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const build = await store.recordContextBuild({
        conversationId: conv.id,
        instructions: [],
        tools: [],
        items: [],
      });
      expect(await store.getContextBuild(build.id)).toEqual(build);
      expect(await store.getContextBuild("missing")).toBeUndefined();
      const first = await store.recordModelUsage({
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: build.id,
        provider: "fake",
        model: "fake-1",
        usage: {
          inputTokens: 1200,
          outputTokens: 80,
          cachedReadTokens: 1000,
          cacheWriteTokens: { 300: 100 },
        },
        cost: 0.0123,
      });
      const second = await store.recordModelUsage({
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: null,
        provider: "fake",
        model: "fake-2", // differs from the conversation's config: the row snapshots the model
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
        cost: null,
        attempts: 2,
      });
      const unknown = await store.recordModelUsage({
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: build.id,
        provider: "compatible",
        model: "usage-omitted",
        usage: null,
        cost: null,
      });
      const noProvider = await store.recordModelUsage({
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: build.id,
        provider: "fake",
        model: "preflight-rejected",
        usage: null,
        cost: null,
        attempts: 0,
      });
      expect(noProvider.attempts).toBe(0);
      expect(await store.listModelUsage(conv.id)).toEqual([first, second, unknown, noProvider]);
      expect(await store.listModelUsage("missing" as ConversationId)).toEqual([]);
      expect(await store.summarizeModelUsage(conv.id)).toEqual({
        usage: {
          inputTokens: 1210,
          outputTokens: 85,
          cachedReadTokens: 1000,
          cacheWriteTokens: { 300: 100 },
        },
        incomplete: true,
        cost: 0.0123,
        costIncomplete: true,
        lastInputTokens: 10,
      });
    });

    it.each([undefined, 0, 1, 2])(
      "retains known usage but marks additional unobserved provider attempts partial (%s)",
      async (attempts) => {
        const store = makeStore();
        const conversation = await store.createConversation(sampleRecord());
        const turn = await store.createTurn(conversation.id);
        const usage = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0 };
        const row = await store.recordModelUsage({
          conversationId: conversation.id,
          turnId: turn.id,
          contextBuildId: null,
          provider: "fake",
          model: "fake-1",
          purpose: "agent",
          requestDurationMs: 1000,
          usage,
          cost: 0.01,
          ...(attempts === undefined ? {} : { attempts }),
        });
        await store.updateTurn(turn.id, "completed");
        const partial = attempts === 2;
        expect(await store.listModelUsage(conversation.id)).toEqual([row]);
        expect(await store.summarizeModelUsage(conversation.id)).toMatchObject({
          usage,
          cost: 0.01,
          incomplete: partial,
          costIncomplete: partial,
          lastInputTokens: 100,
          agentContext: { usage },
          lastTurn: {
            usage,
            cost: 0.01,
            incomplete: partial,
            costIncomplete: partial,
            agentOutputTokens: partial ? null : 10,
            agentDurationMs: partial ? null : 1000,
          },
        });
      },
    );

    it("keeps cumulative billing totals without exposing them as context occupancy", async () => {
      const store = makeStore();
      const conversation = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conversation.id);
      const base = {
        conversationId: conversation.id,
        turnId: turn.id,
        contextBuildId: null,
        provider: "fake",
        model: "fake-1",
        purpose: "agent",
        cost: 0,
      };
      await store.recordModelUsage({
        ...base,
        usage: { inputTokens: 100, outputTokens: 1, cachedReadTokens: 0 },
      });
      const billing = { inputTokens: 20_000, outputTokens: 2, cachedReadTokens: 0 };
      await store.recordModelUsage({ ...base, usage: billing, inputTokensAreContext: false });
      const summary = await store.summarizeModelUsage(conversation.id);
      expect(summary.usage.inputTokens).toBe(20_100);
      expect(summary.agentContext?.usage).toBeNull();
      expect(summary.lastInputTokens).toBeUndefined();
      expect((await store.listModelUsage(conversation.id)).at(-1)).toMatchObject({
        usage: billing,
        inputTokensAreContext: false,
      });
    });

    it("keeps model-specific agent checkpoints and terminal-turn usage separate from other requests", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const request = {
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: null,
        provider: "fake",
        model: "agent",
        purpose: "agent",
        requestDurationMs: 1000,
        usage: { inputTokens: 200, outputTokens: 30, cachedReadTokens: 100 },
        cost: 0.01,
      };
      await store.recordModelUsage(request);
      await store.recordModelUsage({
        ...request,
        purpose: "auto-approval",
        model: "reviewer",
        usage: { inputTokens: 7, outputTokens: 2, cachedReadTokens: 0 },
      });
      expect((await store.summarizeModelUsage(conv.id)).agentContext).toMatchObject({
        provider: "fake",
        model: "agent",
        usage: request.usage,
      });
      expect((await store.summarizeModelUsage(conv.id)).lastTurn).toBeUndefined();
      await store.recordModelUsage({
        ...request,
        model: "unknown-accounting",
        usage: null,
        cost: null,
      });
      expect((await store.summarizeModelUsage(conv.id)).agentContext).toMatchObject({
        model: "unknown-accounting",
        usage: null,
      });
      await store.updateTurn(turn.id, "completed");
      expect((await store.summarizeModelUsage(conv.id)).lastTurn).toMatchObject({
        turnId: turn.id,
        status: "completed",
        incomplete: true,
        usage: { inputTokens: 207, outputTokens: 32 },
        agentOutputTokens: null,
        agentDurationMs: null,
      });
      const next = await store.createTurn(conv.id);
      await store.recordModelUsage({
        ...request,
        turnId: next.id,
        model: "next-model",
        usage: { inputTokens: 12, outputTokens: 50, cachedReadTokens: 0 },
      });
      expect((await store.summarizeModelUsage(conv.id)).lastTurn?.turnId).toBe(turn.id);
      await store.updateTurn(next.id, "aborted");
      expect((await store.summarizeModelUsage(conv.id)).lastTurn).toMatchObject({
        turnId: next.id,
        status: "aborted",
        incomplete: false,
        agentOutputTokens: 50,
        agentDurationMs: 1000,
      });
    });

    it("pages scoped plugin state and preserves scope across value updates", async () => {
      const store = makeStore();
      const parent = await store.createConversation(sampleRecord());
      const first = await store.createConversation(sampleRecord());
      const second = await store.createConversation(sampleRecord());
      const other = await store.createConversation(sampleRecord());
      await store.putPluginState("agents", first.id, "spawn", { name: "first" }, parent.id);
      await store.putPluginState("agents", second.id, "spawn", { name: "second" }, parent.id);
      await store.putPluginState("agents", other.id, "spawn", {}, "another-parent");
      await store.putPluginState("agents", second.id, "spawn", { name: "renamed" });
      const options = { includedState: { plugin: "agents", key: "spawn", scope: parent.id } };
      const page = await store.listConversationPage(1, undefined, options);
      expect(page.map((row) => row.id)).toEqual([second.id]);
      const next = await store.listConversationPage(
        1,
        { createdAt: second.createdAt, id: second.id },
        options,
      );
      expect(next.map((row) => row.id)).toEqual([first.id]);
      expect(await store.getPluginState("agents", second.id, "spawn")).toEqual({ name: "renamed" });
      await store.putPluginState("agents", second.id, "spawn", {}, "another-parent");
      expect(
        (await store.listConversationPage(10, undefined, options)).map((row) => row.id),
      ).toEqual([first.id]);
    });

    it("returns the latest turn including terminal outcomes", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      expect(await store.getLatestTurn(conv.id)).toBeUndefined();
      const first = await store.createTurn(conv.id);
      await store.updateTurn(first.id, "completed");
      const second = await store.createTurn(conv.id);
      expect(await store.getLatestTurn(conv.id)).toEqual(second);
      await store.updateTurn(second.id, "aborted");
      expect((await store.getLatestTurn(conv.id))?.status).toBe("aborted");
    });

    it("namespaces plugin state by plugin + conversation + key", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      await store.putPluginState("p", conv.id, "k", { v: 1 });
      expect(await store.getPluginState("p", conv.id, "k")).toEqual({ v: 1 });
      expect(await store.getPluginState("p", conv.id, "other")).toBeUndefined();
      expect(await store.getPluginState("q", conv.id, "k")).toBeUndefined();
    });

    it("stores blobs and reads byte ranges", async () => {
      const store = makeStore();
      const ref = await store.putBlob(new TextEncoder().encode("hello world"));
      expect(ref.bytes).toBe(11);
      expect(new TextDecoder().decode(await store.getBlob(ref))).toBe("hello world");
      const part = await store.getBlob(ref, { offset: 0, length: 5 });
      expect(new TextDecoder().decode(part)).toBe("hello");
    });
  });
}
