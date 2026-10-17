import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcHost, HarnessRpcSession } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, textStep, toolStep, unusedCodeEvaluator } from "@harness/testkit";
import { createQuestionsPlugin } from "@harness/questions";
import {
  QuestionsClient,
  questionRespondRequest,
  QUESTIONS_CLIENT_CONTRACT_VERSION,
  type ClientQuestionRequest,
} from "@harness/questions/client";
import { textOf, type QuestionResponse } from "@harness/protocol";
import { registerQuestionsServer } from "./questions.ts";

it("replays pending questions on reconnect and resolves all clients once through public RPC", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-questions-rpc-"));
  const provider = new FakeProvider([
    toolStep("ask-1", "ask_questions", {
      questions: [
        {
          id: "platform",
          prompt: "Platforms?",
          selection: "multiple",
          options: [
            { id: "linux", label: "Linux" },
            { id: "windows", label: "Windows" },
          ],
        },
        { id: "details", prompt: "Anything else?" },
      ],
    }),
    textStep("Waiting for your answer."),
    textStep("Received your answer."),
    textStep("Question dismissed."),
  ]);
  const service: HarnessService = new HarnessService({
    home,
    codeEvaluator: unusedCodeEvaluator,
    store: new InMemoryStore(),
    defaults: { model: { provider: "fake", model: "fake-1" } },
    plugins: [
      { id: "fake", providers: () => [provider] },
      createQuestionsPlugin({
        askQuestions: (id, callId, input) => service.askQuestions(id, callId, input),
      }),
    ],
  });
  const host = new HarnessRpcHost(service);
  const clients: HarnessClient[] = [];
  const sessions: HarnessRpcSession[] = [];
  const connect = async () => {
    const pair = createInProcessMessageConnectionPair();
    const session = new HarnessRpcSession({
      connection: pair.right,
      host,
      server: { name: "test", version: "1" },
      plugins: [{ id: "questions", version: QUESTIONS_CLIENT_CONTRACT_VERSION }],
    });
    // Issued question responses remain answerable even in a read-only child view.
    session.registerWriteCheck(async () => {
      throw new Error("Subagent conversations are read-only");
    });
    sessions.push(session);
    registerQuestionsServer(session);
    session.start();
    const client = new HarnessClient({
      connection: pair.left,
      client: { name: "test", version: "1" },
      plugins: [{ id: "questions", version: QUESTIONS_CLIENT_CONTRACT_VERSION }],
    });
    const questions = new QuestionsClient(client);
    await client.start();
    clients.push(client);
    return { client, questions, session };
  };
  try {
    const first = await connect();
    const conversation = await service.createConversation();
    await first.client.attach(conversation.id);
    const firstPending = new Map<string, ClientQuestionRequest>();
    let created!: () => void;
    const appeared = new Promise<void>((resolve) => {
      created = resolve;
    });
    first.questions.subscribe(conversation.id, (event) => {
      if (event.type === "created") {
        firstPending.set(event.request.id, event.request);
        created();
      } else firstPending.delete(event.requestId);
    });
    await service.send(conversation.id, "Ask me.");
    await service.whenIdle(conversation.id);
    expect(service.pendingQuestions(conversation.id)).toHaveLength(1);
    await appeared;
    expect(firstPending.size).toBe(1);
    const request = [...firstPending.values()][0]!;
    await first.session.shutdown(false);

    const second = await connect();
    await second.client.attach(conversation.id);
    const secondPending = new Map<string, ClientQuestionRequest>();
    second.questions.subscribe(conversation.id, (event) =>
      event.type === "created"
        ? secondPending.set(event.request.id, event.request)
        : secondPending.delete(event.requestId),
    );
    expect(secondPending.get(request.id)?.questions).toEqual(request.questions);
    await second.client.attach(conversation.id);
    expect(secondPending.size).toBe(1);
    expect(secondPending.get(request.id)?.questions).toEqual(request.questions);
    const third = await connect();
    await third.client.attach(conversation.id);
    const thirdPending = new Map<string, ClientQuestionRequest>();
    third.questions.subscribe(conversation.id, (event) =>
      event.type === "created"
        ? thirdPending.set(event.request.id, event.request)
        : thirdPending.delete(event.requestId),
    );
    expect(thirdPending.size).toBe(1);

    const response: QuestionResponse = {
      status: "answered",
      answers: [
        {
          questionId: "platform",
          selectedOptionIds: ["linux", "windows"],
          comment: "Both please.",
        },
        { questionId: "details", selectedOptionIds: [], comment: "Keep it simple." },
      ],
    };
    const result = await second.client.peer.request(questionRespondRequest, {
      conversationId: conversation.id,
      requestId: request.id,
      response,
    });
    expect(result.request.response).toEqual(response);
    const retry = await third.client.peer.request(questionRespondRequest, {
      conversationId: conversation.id,
      requestId: request.id,
      response: { status: "dismissed" },
    });
    expect(retry.request.response).toEqual(response);
    await service.whenIdle(conversation.id);
    expect(secondPending.size).toBe(0);
    expect(thirdPending.size).toBe(0);
    const messages = (await service.getItems(conversation.id)).filter(
      (item) => item.type === "message" && item.role === "user",
    );
    expect(messages).toHaveLength(2);
    expect(textOf(messages[1]!.type === "message" ? messages[1]!.content : [])).toContain(
      "Keep it simple.",
    );

    const next = await service.askQuestions(conversation.id, "ask-2", {
      questions: [{ id: "choice", prompt: "Choose?", options: [{ id: "yes", label: "Yes" }] }],
    });
    await expect(
      second.client.peer.request(questionRespondRequest, {
        conversationId: conversation.id,
        requestId: next.id,
        response: {
          status: "answered",
          answers: [{ questionId: "choice", selectedOptionIds: [], comment: "" }],
        },
      }),
    ).rejects.toThrow();
    await second.questions.respond(next.id, { status: "dismissed" });
    await service.whenIdle(conversation.id);
    expect(service.pendingQuestions(conversation.id)).toEqual([]);

    // Maximum pending batches with multibyte text still fit an attachment snapshot.
    for (let index = 0; index < 16; index++)
      await service.askQuestions(conversation.id, `bounded-${index}`, {
        questions: Array.from({ length: 8 }, (_, question) => ({
          id: String(question),
          prompt: "🙂".repeat(400),
        })),
      });
    await second.client.attach(conversation.id);
    expect(secondPending.size).toBe(16);
  } finally {
    for (const client of clients) client.closeConnection();
    await host.shutdown();
    await Promise.all(sessions.map((session) => session.shutdown()));
    await rm(home, { recursive: true, force: true });
  }
});
