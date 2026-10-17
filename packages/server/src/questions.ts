import { ResponseError } from "vscode-jsonrpc";
import {
  QuestionInputError,
  isKernelEvent,
  questionRequestSchema,
  type ConversationId,
} from "@harness/protocol";
import type { HarnessRpcSession } from "@harness/service";
import {
  questionCreatedNotification,
  questionResolvedNotification,
  questionRespondRequest,
  questionsSnapshotSchema,
} from "@harness/questions/client";

/** Public question operations use the same attachment ownership as other features. */
export function registerQuestionsServer(session: HarnessRpcSession): void {
  const service = session.host.service;
  session.registerSnapshot("questions", (rootId) =>
    questionsSnapshotSchema.parse({
      pending: service
        .conversationTreeState(rootId)
        .flatMap(({ conversation }) =>
          service
            .pendingQuestions(conversation.id)
            .map((request) => ({ ...request, rootConversationId: rootId })),
        ),
    }),
  );
  session.onRequest(questionRespondRequest, ({ conversationId, requestId, response }) =>
    session.runAttached(conversationId as ConversationId, async () => {
      try {
        return {
          request: await service.answerQuestion(
            conversationId as ConversationId,
            requestId,
            response,
          ),
        };
      } catch (error) {
        if (error instanceof QuestionInputError) throw new ResponseError(-32602, error.message);
        throw error;
      }
    }),
  );
  session.observeEvents((event, rootId) => {
    if (isKernelEvent(event)) return;
    if (event.type === "question.created") {
      const request = questionRequestSchema.parse(event.request);
      void session
        .notify(questionCreatedNotification, {
          ...request,
          rootConversationId: rootId,
        })
        .catch(() => session.server.peer.terminateProtocol("failed to send question"));
    } else if (event.type === "question.resolved") {
      const request = questionRequestSchema.parse(event.request);
      void session
        .notify(questionResolvedNotification, { rootConversationId: rootId, requestId: request.id })
        .catch(() => session.server.peer.terminateProtocol("failed to send question resolution"));
    }
  });
}
