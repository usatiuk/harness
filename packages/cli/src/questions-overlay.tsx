import { useState, type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { MultiSelect, Select, Spinner, TextInput } from "@inkjs/ui";
import type { ClientQuestionRequest } from "@harness/questions/client";
import type { QuestionResponse } from "@harness/protocol";

type Answers = Extract<QuestionResponse, { status: "answered" }>["answers"];

export function QuestionsOverlay({
  requests,
  respond,
  onClose,
}: {
  requests: ClientQuestionRequest[];
  respond: (requestId: string, response: QuestionResponse) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const [selected, setSelected] = useState<string>();
  const request = requests.find((entry) => entry.id === selected);
  if (request)
    return (
      <QuestionForm
        key={request.id}
        request={request}
        respond={respond}
        onClose={() => setSelected(undefined)}
      />
    );
  return (
    <Box flexDirection="column">
      <Text bold>Questions ({requests.length})</Text>
      <Select
        options={[
          ...requests.map((entry) => ({ value: entry.id, label: entry.questions[0]!.prompt })),
          { value: "close", label: "Close" },
        ]}
        onChange={(id) => (id === "close" ? onClose() : setSelected(id))}
      />
    </Box>
  );
}

function QuestionForm({
  request,
  respond,
  onClose,
}: {
  request: ClientQuestionRequest;
  respond: (requestId: string, response: QuestionResponse) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const [answers, setAnswers] = useState<Answers>([]);
  const [choices, setChoices] = useState<string[]>([]);
  const [stage, setStage] = useState<"choice" | "comment" | "review">("choice");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const question = request.questions[answers.length];
  const submit = async (response: QuestionResponse): Promise<void> => {
    setSending(true);
    setError(undefined);
    try {
      await respond(request.id, response);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSending(false);
    }
  };
  useInput((input, key) => {
    if (!sending && key.ctrl && input === "d") void submit({ status: "dismissed" });
  });
  if (sending) return <Spinner label="Submitting answers" />;
  if (!question || stage === "review")
    return (
      <Box flexDirection="column">
        <Text bold>Submit answers?</Text>
        {answers.map((answer, i) => (
          <Text key={answer.questionId}>
            {request.questions[i]!.prompt}:{" "}
            {[
              ...answer.selectedOptionIds.map(
                (id) => request.questions[i]!.options!.find((option) => option.id === id)!.label,
              ),
              answer.comment,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ))}
        {error && <Text color="red">{error}</Text>}
        <Select
          options={[
            { value: "submit", label: "Submit answers" },
            { value: "restart", label: "Edit answers" },
            { value: "dismiss", label: "Dismiss request" },
            { value: "close", label: "Answer later" },
          ]}
          onChange={(action) => {
            if (action === "submit") void submit({ status: "answered", answers });
            else if (action === "dismiss") void submit({ status: "dismissed" });
            else if (action === "restart") {
              setAnswers([]);
              setChoices([]);
              setStage("choice");
            } else onClose();
          }}
        />
      </Box>
    );
  const choose = (ids: string[]): void => {
    setChoices(ids);
    setStage("comment");
  };
  const commentStage = stage === "comment" || !question.options?.length;
  return (
    <Box flexDirection="column">
      <Text bold>
        {question.prompt} ({answers.length + 1}/{request.questions.length})
      </Text>
      {error && <Text color="red">{error}</Text>}
      {commentStage ? (
        <>
          <Text dimColor>Answer or comment (optional with a selection)</Text>
          <TextInput
            key={`${question.id}:comment`}
            onSubmit={(comment) => {
              if (!choices.length && !comment.trim()) {
                setError("Choose an option or enter an answer.");
                return;
              }
              setAnswers([
                ...answers,
                { questionId: question.id, selectedOptionIds: choices, comment },
              ]);
              setChoices([]);
              setStage(answers.length + 1 === request.questions.length ? "review" : "choice");
              setError(undefined);
            }}
          />
        </>
      ) : question.selection === "multiple" ? (
        <>
          <Text dimColor>
            Space selects · Enter continues with any number of choices, including none
          </Text>
          <MultiSelect
            key={question.id}
            options={question.options!.map((option) => ({ value: option.id, label: option.label }))}
            onSubmit={choose}
          />
        </>
      ) : (
        <Select
          key={question.id}
          options={[
            ...question.options!.map((option, index) => ({
              value: String(index),
              label: option.label,
            })),
            { value: "none", label: "No option — write an answer" },
          ]}
          onChange={(value) =>
            choose(value === "none" ? [] : [question.options![Number(value)]!.id])
          }
        />
      )}
      <Text dimColor>Ctrl+D dismisses request · Esc closes without dismissing</Text>
    </Box>
  );
}
