import { expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { act } from "react";
import type { ClientQuestionRequest } from "@harness/questions/client";
import type { QuestionInput } from "@harness/protocol";
import { QuestionsOverlay } from "./questions-overlay.tsx";

const request = (questions: QuestionInput["questions"]): ClientQuestionRequest => ({
  id: "request",
  rootConversationId: "conversation",
  conversationId: "conversation",
  callId: "call",
  createdAt: 1,
  questions: questions.map((question) => ({
    ...question,
    options: question.options ?? null,
    selection: question.selection ?? "single",
  })),
  response: null,
});
const mount = (questions: QuestionInput["questions"]) => {
  const respond = vi.fn(async () => {});
  const ui = render(
    <QuestionsOverlay requests={[request(questions)]} respond={respond} onClose={() => {}} />,
  );
  return {
    ...ui,
    respond,
    input: async (text: string) => {
      // A rendered Ink frame precedes useInput's passive subscription effect.
      await act(async () => {});
      await act(async () => {
        ui.stdin.write(text);
      });
    },
  };
};

it("submits a comment without choosing an option", async () => {
  const app = mount([
    { id: "scope", prompt: "Which scope?", options: [{ id: "one", label: "One" }] },
  ]);
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("No option"));
  await app.input("\u001b[B");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("❯ No option"));
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Answer or comment"));
  await app.input("Different scope");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Different scope"));
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Submit answers?"));
  await app.input("\r");
  await vi.waitFor(() =>
    expect(app.respond).toHaveBeenCalledWith("request", {
      status: "answered",
      answers: [{ questionId: "scope", selectedOptionIds: [], comment: "Different scope" }],
    }),
  );
  app.unmount();
});

it("submits multiple choices and a comment together with a second freeform answer", async () => {
  const app = mount([
    {
      id: "scope",
      prompt: "Which scope?",
      selection: "multiple",
      options: [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ],
    },
    { id: "notes", prompt: "Any constraints?" },
  ]);
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Space selects"));
  await app.input(" ");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("One ✔"));
  await app.input("\u001b[B");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("❯ Two"));
  await app.input(" ");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Two ✔"));
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Answer or comment"));
  await app.input("Both please");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Both please"));
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Any constraints?"));
  await app.input("Keep it simple");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Keep it simple"));
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Submit answers?"));
  await app.input("\r");
  await vi.waitFor(() =>
    expect(app.respond).toHaveBeenCalledWith("request", {
      status: "answered",
      answers: [
        { questionId: "scope", selectedOptionIds: ["one", "two"], comment: "Both please" },
        { questionId: "notes", selectedOptionIds: [], comment: "Keep it simple" },
      ],
    }),
  );
  app.unmount();
});

it("can explicitly dismiss an unanswered request", async () => {
  const app = mount([{ id: "free", prompt: "Tell me more" }]);
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Answer or comment"));
  await app.input("\u0004");
  await vi.waitFor(() =>
    expect(app.respond).toHaveBeenCalledWith("request", { status: "dismissed" }),
  );
  app.unmount();
});

it("allows a selected option without a comment", async () => {
  const app = mount([
    { id: "scope", prompt: "Which scope?", options: [{ id: "one", label: "One" }] },
  ]);
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("No option"));
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Answer or comment"));
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Submit answers?"));
  await app.input("\r");
  await vi.waitFor(() =>
    expect(app.respond).toHaveBeenCalledWith("request", {
      status: "answered",
      answers: [{ questionId: "scope", selectedOptionIds: ["one"], comment: "" }],
    }),
  );
  app.unmount();
});

it("skips an individual choice question and answers the remaining text question", async () => {
  const app = mount([
    { id: "scope", prompt: "Which scope?", options: [{ id: "one", label: "One" }] },
    { id: "notes", prompt: "Any notes?" },
  ]);
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Ctrl+S skips question"));
  await app.input("\u0013");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Any notes?"));
  await app.input("Keep it simple");
  await app.input("\r");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("Which scope?: Skipped"));
  await app.input("\r");
  await vi.waitFor(() =>
    expect(app.respond).toHaveBeenCalledWith("request", {
      status: "answered",
      answers: [
        { questionId: "scope", skipped: true },
        { questionId: "notes", selectedOptionIds: [], comment: "Keep it simple" },
      ],
    }),
  );
  app.unmount();
});
