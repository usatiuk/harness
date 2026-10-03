import { isKernelEvent, jsonValueSchema } from "@harness/protocol";
import type { ConversationId, InteractionRequest } from "@harness/protocol";
import type { HarnessRpcSession, HarnessService } from "@harness/service";
import {
  isApprovalRequest,
  approvalCreatedNotification,
  approvalResolvedNotification,
  approvalDecideRequest,
} from "@harness/approval";

export function registerApprovalServer(
  rpcSession: HarnessRpcSession,
  service: HarnessService,
): void {
  const approval = (
    requestId: string,
    conversationId: ConversationId,
    request: InteractionRequest,
    rootId: ConversationId,
  ) => {
    if (!isApprovalRequest(request)) throw new Error("request is not an approval");
    return {
      requestId,
      rootConversationId: rootId,
      conversationId,
      call: {
        callId: request.call.callId,
        name: request.call.name,
        args: jsonValueSchema.parse(request.call.args),
      },
      relationship: request.relationship,
    };
  };
  rpcSession.registerSnapshot("approval", (rootId) => ({
    pending: service
      .pendingRequests(rootId)
      .filter((pending) => isApprovalRequest(pending.request))
      .map((pending) =>
        approval(pending.requestId, pending.conversationId, pending.request, rootId),
      ),
  }));
  rpcSession.onRequest(approvalDecideRequest, ({ conversationId, requestId, decision }) =>
    rpcSession.runAttached(conversationId as ConversationId, async () => {
      const id = conversationId as ConversationId;
      const pending = service
        .pendingRequests(service.rootConversationOf(id))
        .find(
          (p) =>
            p.requestId === requestId && p.conversationId === id && isApprovalRequest(p.request),
        );
      if (pending === undefined) return { resolved: false };
      service.respond(id, requestId, { decision });
      return { resolved: true };
    }),
  );
  rpcSession.observeEvents((event, rootId) => {
    if (!isKernelEvent(event)) return;
    if (event.type === "request.created" && isApprovalRequest(event.request)) {
      void rpcSession
        .notify(
          approvalCreatedNotification,
          approval(event.requestId, event.conversationId, event.request, rootId),
        )
        .catch(() => rpcSession.server.peer.terminateProtocol("failed to send approval"));
    } else if (event.type === "request.resolved") {
      void rpcSession
        .notify(approvalResolvedNotification, {
          rootConversationId: rootId,
          requestId: event.requestId,
        })
        .catch(() =>
          rpcSession.server.peer.terminateProtocol("failed to send approval resolution"),
        );
    }
  });
}
