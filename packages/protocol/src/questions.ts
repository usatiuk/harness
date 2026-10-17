import { z } from "zod";
import type { ConversationId } from "./ids.ts";

const identifier = z.string().trim().min(1).max(100);
const questionSchema = z.strictObject({
  id: identifier,
  prompt: z.string().trim().min(1).max(4000),
  options: z
    .array(z.strictObject({ id: identifier, label: z.string().trim().min(1).max(1000) }))
    .min(1)
    .max(12)
    .optional(),
  selection: z.enum(["single", "multiple"]).optional(),
});
export const questionInputSchema = z
  .strictObject({
    questions: z.array(questionSchema).min(1).max(8),
  })
  .superRefine(({ questions }, ctx) => {
    // A full pending snapshot must fit the existing bounded attachment frame, including Unicode.
    if (new TextEncoder().encode(JSON.stringify({ questions })).byteLength > 16 * 1024)
      ctx.addIssue({ code: "custom", message: "Question batch exceeds 16 KiB of UTF-8 JSON" });
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      ctx.addIssue({ code: "custom", message: "Question IDs must be unique" });
    for (const q of questions) {
      if (q.options && new Set(q.options.map((o) => o.id)).size !== q.options.length)
        ctx.addIssue({ code: "custom", message: "Option IDs must be unique within a question" });
      if (q.selection && !q.options)
        ctx.addIssue({ code: "custom", message: "Selection requires options" });
    }
  });
export type QuestionInput = z.infer<typeof questionInputSchema>;
export const questionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("answered"),
    answers: z
      .array(
        z.strictObject({
          questionId: identifier,
          selectedOptionIds: z.array(identifier).max(12),
          comment: z.string().max(8000),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({ status: z.literal("dismissed") }),
]);
export type QuestionResponse = z.infer<typeof questionResponseSchema>;
export const questionRequestSchema = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  callId: z.string(),
  questions: z
    .array(
      questionSchema.extend({
        options: questionSchema.shape.options.unwrap().nullable(),
        selection: z.enum(["single", "multiple"]),
      }),
    )
    .min(1)
    .max(8),
  createdAt: z.number(),
  response: questionResponseSchema.nullable(),
});
export type QuestionRequest = Omit<z.infer<typeof questionRequestSchema>, "conversationId"> & {
  conversationId: ConversationId;
};
export interface StoredQuestion {
  request: QuestionRequest;
  deliveryPending: boolean;
}
export const MAX_PENDING_QUESTIONS = 16;

/** Expected invalid user input, safe to present at the public boundary. */
export class QuestionInputError extends Error {}

/** Validate against the recorded request; labels and model-supplied IDs are never inferred. */
export function validateQuestionResponse(
  request: QuestionRequest,
  response: QuestionResponse,
): void {
  if (response.status === "dismissed") return;
  const answers = new Map(response.answers.map((a) => [a.questionId, a]));
  if (answers.size !== response.answers.length || answers.size !== request.questions.length)
    throw new QuestionInputError("Answer every question exactly once");
  for (const question of request.questions) {
    const answer = answers.get(question.id);
    if (!answer) throw new QuestionInputError(`Missing answer: ${question.id}`);
    const selected = new Set(answer.selectedOptionIds);
    if (
      selected.size !== answer.selectedOptionIds.length ||
      [...selected].some((id) => !question.options?.some((o) => o.id === id))
    )
      throw new QuestionInputError(`Invalid option selection: ${question.id}`);
    if (question.selection !== "multiple" && selected.size > 1)
      throw new QuestionInputError(`Select at most one option: ${question.id}`);
    if (selected.size === 0 && !answer.comment.trim())
      throw new QuestionInputError(`Select an option or enter a comment: ${question.id}`);
  }
}
