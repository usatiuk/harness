import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore } from "@harness/store";
import { SqliteStore } from "@harness/store-sqlite";
import {
  questionInputSchema,
  textOf,
  questionResponseSchema,
  type QuestionInput,
  type QuestionResponse,
  type Store,
} from "@harness/protocol";
import { FakeProvider, GateTool, textStep, toolStep, unusedCodeEvaluator } from "@harness/testkit";
import { createQuestionsPlugin } from "../../questions/src/index.ts";
import { HarnessService } from "./service.ts";

const input: QuestionInput = {
  questions: [
    {
      id: "platform",
      prompt: "Which platforms?",
      selection: "multiple",
      options: [
        { id: "linux", label: "Linux" },
        { id: "mac", label: "macOS" },
      ],
    },
    { id: "constraints", prompt: "Any constraints?" },
  ],
};
const response: QuestionResponse = {
  status: "answered",
  answers: [
    { questionId: "platform", selectedOptionIds: ["linux", "mac"], comment: "Windows later" },
    { questionId: "constraints", selectedOptionIds: [], comment: "Keep it simple" },
  ],
};
const serviceOn = (
  store: Store,
  steps: ConstructorParameters<typeof FakeProvider>[0],
  gate?: GateTool,
) => {
  const service: HarnessService = new HarnessService({
    store,
    home: "/nonexistent-harness-home",
    codeEvaluator: unusedCodeEvaluator,
    defaults: { model: { provider: "fake", model: "fake-1" } },
    plugins: [
      { id: "fake", providers: () => [new FakeProvider(steps)], tools: () => (gate ? [gate] : []) },
      createQuestionsPlugin({ askQuestions: (...args) => service.askQuestions(...args) }),
    ],
  });
  return service;
};
const responseMessages = async (
  service: HarnessService,
  id: Parameters<HarnessService["getItems"]>[0],
) =>
  (await service.getItems(id)).filter(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.source?.kind === "user" &&
      item.content.some(
        (block) =>
          block.type === "text" &&
          (block.text.startsWith("User answered your questions:") ||
            block.text.startsWith("User dismissed your questions:")),
      ),
  );

describe("async questions", () => {
  it("returns immediately, keeps a batch open after the turn ends, and delivers one answer on retry", async () => {
    const service = serviceOn(new InMemoryStore(), [
      toolStep("ask-1", "ask_questions", input),
      textStep("I can continue independent work"),
      textStep("Got the answer"),
    ]);
    const conversation = await service.createConversation();
    await service.send(conversation.id, "Help me");
    await service.whenIdle(conversation.id);
    const [request] = service.pendingQuestions(conversation.id);
    expect(request?.questions).toHaveLength(2);
    expect((await service.getItems(conversation.id)).at(-1)).toMatchObject({
      content: [{ type: "text", text: "I can continue independent work" }],
    });
    await Promise.all([
      service.answerQuestion(conversation.id, request!.id, response),
      service.answerQuestion(conversation.id, request!.id, response),
    ]);
    await service.whenIdle(conversation.id);
    expect(service.pendingQuestions(conversation.id)).toEqual([]);
    expect(await responseMessages(service, conversation.id)).toMatchObject([
      {
        source: { kind: "user" },
        content: [
          {
            type: "text",
            text: "User answered your questions:\n\nWhich platforms?\nSelected: Linux; macOS\nWindows later\n\nAny constraints?\nKeep it simple",
          },
        ],
      },
    ]);
    expect((await service.getItems(conversation.id)).at(-1)).toMatchObject({
      content: [{ type: "text", text: "Got the answer" }],
    });
    expect(
      await service.answerQuestion(conversation.id, request!.id, { status: "dismissed" }),
    ).toMatchObject({ response });
    await service.deactivateSession(conversation.id);
  });

  it("steers an answer into ongoing work at its next tool-result boundary", async () => {
    const gate = new GateTool();
    const service = serviceOn(
      new InMemoryStore(),
      [
        toolStep("ask", "ask_questions", input),
        toolStep("work", "gate", {}),
        textStep("Used the answer"),
      ],
      gate,
    );
    const conversation = await service.createConversation();
    await service.send(conversation.id, "Start");
    await gate.started;
    const request = service.pendingQuestions(conversation.id)[0]!;
    await service.answerQuestion(conversation.id, request.id, response);
    expect(await responseMessages(service, conversation.id)).toHaveLength(0);
    gate.release();
    await service.whenIdle(conversation.id);
    const messages = await responseMessages(service, conversation.id);
    const items = await service.getItems(conversation.id);
    expect(messages).toHaveLength(1);
    expect(new Set(items.map((item) => item.turnId)).size).toBe(1);
    expect(
      items.findIndex((item) => item.type === "tool_result" && item.callId === "work"),
    ).toBeLessThan(items.indexOf(messages[0]!));
    await service.deactivateSession(conversation.id);
  });

  it("retains an accepted answer when the current session work is cancelled", async () => {
    const gate = new GateTool({ honorSignal: true });
    const service = serviceOn(
      new InMemoryStore(),
      [
        toolStep("ask", "ask_questions", input),
        toolStep("work", "gate", {}),
        textStep("Answer after cancellation"),
      ],
      gate,
    );
    const conversation = await service.createConversation();
    await service.send(conversation.id, "Start");
    await gate.started;
    const request = service.pendingQuestions(conversation.id)[0]!;
    await service.answerQuestion(conversation.id, request.id, response);
    service.cancelSession(conversation.id);
    await service.whenIdle(conversation.id);
    expect(await responseMessages(service, conversation.id)).toHaveLength(1);
    await service.deactivateSession(conversation.id);
  });

  it("defers an accepted answer through forced deactivation until the conversation is reopened", async () => {
    const gate = new GateTool({ honorSignal: true });
    const store = new InMemoryStore();
    const service = serviceOn(
      store,
      [
        toolStep("ask", "ask_questions", input),
        toolStep("work", "gate", {}),
        textStep("Answer after reopen"),
      ],
      gate,
    );
    const conversation = await service.createConversation();
    await service.send(conversation.id, "Start");
    await gate.started;
    const request = service.pendingQuestions(conversation.id)[0]!;
    await service.answerQuestion(conversation.id, request.id, response);
    await service.deactivateSession(conversation.id, { force: true });
    expect((await store.getLatestTurn(conversation.id))?.status).toBe("aborted");
    expect(await store.listPendingQuestions(conversation.id)).toMatchObject([
      { deliveryPending: true },
    ]);
    await service.prepare(conversation.id);
    await service.whenIdle(conversation.id);
    expect(await responseMessages(service, conversation.id)).toHaveLength(1);
    await service.deactivateSession(conversation.id);
  });

  it("leaves the question answerable after its originating turn is stopped", async () => {
    const gate = new GateTool({ honorSignal: true });
    const service = serviceOn(
      new InMemoryStore(),
      [
        toolStep("ask", "ask_questions", input),
        toolStep("work", "gate", {}),
        textStep("Answer after stop"),
      ],
      gate,
    );
    const conversation = await service.createConversation();
    await service.send(conversation.id, "Start");
    await gate.started;
    const request = service.pendingQuestions(conversation.id)[0]!;
    await service.deliver(conversation.id, "", "interrupt");
    await service.whenIdle(conversation.id);
    expect(service.pendingQuestions(conversation.id)).toEqual([request]);
    await service.answerQuestion(conversation.id, request.id, response);
    await service.whenIdle(conversation.id);
    expect(await responseMessages(service, conversation.id)).toHaveLength(1);
    await service.deactivateSession(conversation.id);
  });

  it("accepts a comment without selection and rejects empty, unknown, duplicate, and excess single selections", async () => {
    const service = serviceOn(new InMemoryStore(), [textStep("Answered"), textStep("Dismissed")]);
    const conversation = await service.createConversation();
    const request = await service.askQuestions(conversation.id, "single", {
      questions: [
        {
          id: "one",
          prompt: "Choose",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    });
    for (const ids of [[], ["unknown"], ["a", "a"], ["a", "b"]]) {
      await expect(
        service.answerQuestion(conversation.id, request.id, {
          status: "answered",
          answers: [{ questionId: "one", selectedOptionIds: ids, comment: "" }],
        }),
      ).rejects.toThrow();
    }
    await service.answerQuestion(conversation.id, request.id, {
      status: "answered",
      answers: [{ questionId: "one", selectedOptionIds: [], comment: "None of these" }],
    });
    await service.whenIdle(conversation.id);
    const dismissed = await service.askQuestions(conversation.id, "dismiss", {
      questions: [{ id: "free", prompt: "Explain?" }],
    });
    await service.answerQuestion(conversation.id, dismissed.id, { status: "dismissed" });
    await service.whenIdle(conversation.id);
    expect(await responseMessages(service, conversation.id)).toHaveLength(2);
    await service.deactivateSession(conversation.id);
  });

  it("restores open questions and accepted undelivered answers after a server restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-questions-"));
    const path = join(home, "store.db");
    let store = new SqliteStore(path);
    try {
      const first = serviceOn(store, []);
      const conversation = await first.createConversation();
      const request = await first.askQuestions(conversation.id, "ask", input);
      await first.deactivateSession(conversation.id);
      store.close();
      store = new SqliteStore(path);
      const second = serviceOn(store, []);
      await second.prepare(conversation.id);
      expect(second.pendingQuestions(conversation.id)).toEqual([request]);
      // Simulate process exit after committing the answer but before queuing its wakeup.
      await store.resolveQuestion(conversation.id, request.id, response);
      await second.deactivateSession(conversation.id);
      store.close();
      store = new SqliteStore(path);
      const third = serviceOn(store, [textStep("Recovered answer")]);
      await third.prepare(conversation.id);
      await third.whenIdle(conversation.id);
      expect(third.pendingQuestions(conversation.id)).toEqual([]);
      expect(await responseMessages(third, conversation.id)).toHaveLength(1);
      await third.answerQuestion(conversation.id, request.id, response);
      await third.whenIdle(conversation.id);
      expect(await responseMessages(third, conversation.id)).toHaveLength(1);
      await third.deactivateSession(conversation.id);
      store.close();
      store = new SqliteStore(path);
      const fourth = serviceOn(store, []);
      await fourth.prepare(conversation.id);
      await fourth.answerQuestion(conversation.id, request.id, response);
      await fourth.whenIdle(conversation.id);
      expect(await responseMessages(fourth, conversation.id)).toHaveLength(1);
      await fourth.deactivateSession(conversation.id);
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("restores explicit skips alongside answers and also accepts an entirely skipped batch", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-question-skips-"));
    const path = join(home, "store.db");
    let store = new SqliteStore(path);
    try {
      const first = serviceOn(store, []);
      const conversation = await first.createConversation();
      const request = await first.askQuestions(conversation.id, "ask", input);
      const mixed: QuestionResponse = {
        status: "answered",
        answers: [
          { questionId: "platform", skipped: true },
          { questionId: "constraints", selectedOptionIds: [], comment: "Keep it simple" },
        ],
      };
      await store.resolveQuestion(conversation.id, request.id, mixed);
      await first.deactivateSession(conversation.id);
      store.close();
      store = new SqliteStore(path);
      const restored = serviceOn(store, [
        textStep("Received mixed response"),
        textStep("Received skips"),
      ]);
      await restored.prepare(conversation.id);
      await restored.whenIdle(conversation.id);
      const messages = await responseMessages(restored, conversation.id);
      expect(messages).toHaveLength(1);
      const delivered = messages[0];
      if (delivered?.type !== "message") throw new Error("Expected a user answer message");
      expect(textOf(delivered.content)).toContain("Which platforms?\nSkipped");
      await expect(
        restored.answerQuestion(conversation.id, request.id, mixed),
      ).resolves.toMatchObject({ response: mixed });
      const next = await restored.askQuestions(conversation.id, "skip-all", input);
      await restored.answerQuestion(conversation.id, next.id, {
        status: "answered",
        answers: input.questions.map((q) => ({ questionId: q.id, skipped: true })),
      });
      await restored.whenIdle(conversation.id);
      expect(await responseMessages(restored, conversation.id)).toHaveLength(2);
      expect(restored.pendingQuestions(conversation.id)).toEqual([]);
      await restored.deactivateSession(conversation.id);
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bounds pending requests and validates batch schemas", async () => {
    expect(
      questionInputSchema.safeParse({
        questions: [
          { id: "x", prompt: "X" },
          { id: "x", prompt: "Y" },
        ],
      }).success,
    ).toBe(false);
    const unicodeBatch = {
      questions: [
        { id: "a", prompt: "界".repeat(3000) },
        { id: "b", prompt: "界".repeat(3000) },
      ],
    };
    expect(JSON.stringify(unicodeBatch).length).toBeLessThan(16 * 1024);
    expect(questionInputSchema.safeParse(unicodeBatch).success).toBe(false);
    expect(questionResponseSchema.safeParse({ status: "answered", answers: [] }).success).toBe(
      false,
    );
    const service = serviceOn(new InMemoryStore(), []);
    const conversation = await service.createConversation();
    for (let i = 0; i < 16; ++i) await service.askQuestions(conversation.id, String(i), input);
    await expect(service.askQuestions(conversation.id, "overflow", input)).rejects.toThrow(
      "Too many pending",
    );
    await service.deactivateSession(conversation.id);
  });
});
