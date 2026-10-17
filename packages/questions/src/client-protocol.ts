import { z } from "zod";
import {
  defineNotification,
  defineRequest,
  questionRequestSchema,
  questionResponseSchema,
} from "@harness/protocol";

export const QUESTIONS_CLIENT_CONTRACT_VERSION = 2;
export const clientQuestionRequestSchema = questionRequestSchema.extend({
  rootConversationId: z.string(),
});
export const questionsSnapshotSchema = z.strictObject({
  pending: z.array(clientQuestionRequestSchema),
});
export const questionCreatedNotification = defineNotification({
  direction: "server-to-client",
  method: "plugin.questions.created",
  params: clientQuestionRequestSchema,
});
export const questionResolvedNotification = defineNotification({
  direction: "server-to-client",
  method: "plugin.questions.resolved",
  params: z.strictObject({ rootConversationId: z.string(), requestId: z.string() }),
});
export const questionRespondRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.questions.respond",
  params: z.strictObject({
    conversationId: z.string(),
    requestId: z.string(),
    response: questionResponseSchema,
  }),
  result: z.strictObject({ request: questionRequestSchema }),
});
export type ClientQuestionRequest = z.infer<typeof clientQuestionRequestSchema>;
