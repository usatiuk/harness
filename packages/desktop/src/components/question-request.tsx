import { useId, useState } from "react";
import { useFetcher } from "react-router";
import type { ClientQuestionRequest } from "@harness/questions/client";
import type { QuestionResponse } from "@harness/protocol";
import { Button, Checkbox, Input } from "../ui.tsx";

export function QuestionRequestForm({ request }: { request: ClientQuestionRequest }) {
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  const bodyId = useId();
  const [hidden, setHidden] = useState(false);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState(() =>
    request.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: [] as string[],
      comment: "",
      skipped: false,
    })),
  );
  const answered = (answer: (typeof answers)[number]) =>
    answer.skipped || answer.selectedOptionIds.length > 0 || answer.comment.trim().length > 0;
  const question = request.questions[index]!;
  const answer = answers[index]!;
  const last = index === request.questions.length - 1;
  return (
    <section
      className={`question-request${hidden ? " is-collapsed" : ""}`}
      aria-label="Agent questions"
    >
      <div className="question-header">
        <span>
          Question {index + 1} of {request.questions.length}
        </span>
        <Button
          type="button"
          aria-expanded={!hidden}
          aria-controls={bodyId}
          onClick={() => setHidden(!hidden)}
        >
          {hidden ? "Show questions" : "Hide questions"}
        </Button>
      </div>
      <div id={bodyId} hidden={hidden}>
        <fetcher.Form method="post" action="/actions">
          <Input type="hidden" name="intent" value="question" />
          <Input type="hidden" name="requestId" value={request.id} />
          <Input
            type="hidden"
            name="response"
            value={JSON.stringify({
              status: "answered",
              answers: answers.map(({ skipped, ...entry }) =>
                skipped ? { questionId: entry.questionId, skipped: true } : entry,
              ),
            } satisfies QuestionResponse)}
          />
          <fieldset disabled={fetcher.state !== "idle"}>
            <legend>
              {question.prompt}
              {answer.skipped && " (skipped)"}
            </legend>
            <div className="question-field" key={question.id}>
              {question.options && (
                <div className="question-options">
                  {question.options.map((option) => (
                    <label key={option.id}>
                      <Checkbox
                        checked={answer.selectedOptionIds.includes(option.id)}
                        onChange={(event) =>
                          setAnswers((current) =>
                            current.map((entry, i) =>
                              i !== index
                                ? entry
                                : {
                                    ...entry,
                                    skipped: false,
                                    selectedOptionIds: event.target.checked
                                      ? question.selection === "multiple"
                                        ? [...entry.selectedOptionIds, option.id]
                                        : [option.id]
                                      : entry.selectedOptionIds.filter((id) => id !== option.id),
                                  },
                            ),
                          )
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              )}
              <label className="question-comment">
                Answer or comment
                <Input
                  value={answer.comment}
                  onChange={(event) =>
                    setAnswers((current) =>
                      current.map((entry, i) =>
                        i === index
                          ? { ...entry, skipped: false, comment: event.target.value }
                          : entry,
                      ),
                    )
                  }
                  placeholder={
                    question.options
                      ? "Choose options, write an answer, or both"
                      : "Write an answer"
                  }
                  maxLength={8000}
                  onKeyDown={(event) => {
                    // Enter must not trigger the form's Dismiss submit button.
                    if (event.key === "Enter") event.preventDefault();
                  }}
                />
              </label>
            </div>
            <div className="question-actions">
              <Button type="submit" name="dismiss" value="true">
                Dismiss
              </Button>
              <div className="button-row">
                <Button
                  type="button"
                  onClick={() => {
                    setAnswers((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, skipped: true } : entry,
                      ),
                    );
                    if (!last) setIndex(index + 1);
                  }}
                >
                  Skip
                </Button>
                {index > 0 && (
                  <Button type="button" onClick={() => setIndex(index - 1)}>
                    Back
                  </Button>
                )}
                {last ? (
                  <Button type="submit" variant="accent" disabled={!answers.every(answered)}>
                    Submit answers
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="accent"
                    disabled={!answered(answer)}
                    onClick={() => setIndex(index + 1)}
                  >
                    Next
                  </Button>
                )}
              </div>
            </div>
          </fieldset>
        </fetcher.Form>
        {fetcher.data?.ok === false && <p role="alert">{fetcher.data.message}</p>}
      </div>
    </section>
  );
}
