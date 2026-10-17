import { useState } from "react";
import { useFetcher } from "react-router";
import type { ClientQuestionRequest } from "@harness/questions/client";
import type { QuestionResponse } from "@harness/protocol";
import { Button, Checkbox, Input, Textarea } from "../ui.tsx";

export function QuestionRequestForm({ request }: { request: ClientQuestionRequest }) {
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  const [answers, setAnswers] = useState(() =>
    request.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: [] as string[],
      comment: "",
    })),
  );
  const complete = answers.every(
    (answer) => answer.selectedOptionIds.length || answer.comment.trim(),
  );
  return (
    <section className="question-request" aria-label="Agent questions">
      <fetcher.Form method="post" action="/actions">
        <Input type="hidden" name="intent" value="question" />
        <Input type="hidden" name="requestId" value={request.id} />
        <Input
          type="hidden"
          name="response"
          value={JSON.stringify({ status: "answered", answers } satisfies QuestionResponse)}
        />
        <fieldset disabled={fetcher.state !== "idle"}>
          <legend>Questions</legend>
          {request.questions.map((question, index) => (
            <div className="question-field" key={question.id}>
              <strong>{question.prompt}</strong>
              {question.options?.map((option) => (
                <label key={option.id}>
                  <Checkbox
                    checked={answers[index]!.selectedOptionIds.includes(option.id)}
                    onChange={(event) =>
                      setAnswers((current) =>
                        current.map((answer, i) =>
                          i !== index
                            ? answer
                            : {
                                ...answer,
                                selectedOptionIds: event.target.checked
                                  ? question.selection === "multiple"
                                    ? [...answer.selectedOptionIds, option.id]
                                    : [option.id]
                                  : answer.selectedOptionIds.filter((id) => id !== option.id),
                              },
                        ),
                      )
                    }
                  />
                  {option.label}
                </label>
              ))}
              <label>
                Answer or comment
                <Textarea
                  value={answers[index]!.comment}
                  onChange={(event) =>
                    setAnswers((current) =>
                      current.map((answer, i) =>
                        i === index ? { ...answer, comment: event.target.value } : answer,
                      ),
                    )
                  }
                  placeholder="Choose options, write an answer, or both"
                  maxLength={8000}
                  rows={2}
                />
              </label>
            </div>
          ))}
          <div className="button-row">
            <Button type="submit" name="dismiss" value="true">
              Dismiss
            </Button>
            <Button type="submit" variant="accent" disabled={!complete}>
              Submit answers
            </Button>
          </div>
        </fieldset>
      </fetcher.Form>
      {fetcher.data?.ok === false && <p role="alert">{fetcher.data.message}</p>}
    </section>
  );
}
