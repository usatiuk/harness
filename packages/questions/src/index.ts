import {
  questionInputSchema,
  type ConversationId,
  type Plugin,
  type QuestionInput,
  type QuestionRequest,
  type Tool,
} from "@harness/protocol";
export function createQuestionsPlugin(options: {
  askQuestions(id: ConversationId, callId: string, input: QuestionInput): Promise<QuestionRequest>;
}): Plugin {
  const tool: Tool<QuestionInput> = {
    name: "ask_questions",
    essential: true,
    description:
      "Ask the user one or more questions. Returns immediately with a request ID; the user's answer arrives as conversation input. Options are suggestions: users can select none and write a comment, or add a comment to their selection. Users can explicitly skip individual questions; a skip is not an answer or approval. Continue independent work while waiting. If further work needs the answer, end your turn and wait; silence is never approval.",
    input: { kind: "function", schema: questionInputSchema },
    async execute(input, ctx) {
      ctx.signal.throwIfAborted();
      const request = await options.askQuestions(ctx.conversationId, ctx.callId, input);
      return {
        status: "ok",
        forModel: [
          {
            type: "text",
            text: `Questions submitted (${request.id}). The answer will arrive as conversation input.`,
          },
        ],
        structured: { requestId: request.id },
      };
    },
  };
  return { id: "questions", tools: () => [tool] };
}
