import type { HarnessClient } from "@harness/client";
import type { QuestionResponse } from "@harness/protocol";
import {
  questionCreatedNotification,
  questionResolvedNotification,
  questionRespondRequest,
  questionsSnapshotSchema,
  type ClientQuestionRequest,
} from "./client-protocol.ts";
export * from "./client-protocol.ts";
export type { QuestionResponse } from "@harness/protocol";

export type QuestionClientEvent =
  { type: "created"; request: ClientQuestionRequest } | { type: "resolved"; requestId: string };

/** Pending questions follow attachment lifetime; the server owns their resolution. */
export class QuestionsClient {
  readonly #client: HarnessClient;
  readonly #pending = new Map<string, ClientQuestionRequest>();
  readonly #listeners = new Map<string, Set<(event: QuestionClientEvent) => void>>();
  constructor(client: HarnessClient) {
    this.#client = client;
    client.subscribe((event) => {
      if (event.type === "detached") this.#clear(event.rootConversationId);
      if (event.type !== "attached") return;
      const root = event.attachment.root.id;
      this.#clear(root);
      for (const request of questionsSnapshotSchema.parse(
        event.attachment.plugins["questions"] ?? { pending: [] },
      ).pending)
        this.#add(request);
    });
    client.peer.onNotification(questionCreatedNotification, (request) => {
      client.receive(request.rootConversationId, request, () => this.#add(request));
    });
    client.peer.onNotification(questionResolvedNotification, (params) => {
      client.receive(params.rootConversationId, params, () =>
        this.#remove(params.rootConversationId, params.requestId),
      );
    });
  }
  subscribe(root: string, listener: (event: QuestionClientEvent) => void): () => void {
    let listeners = this.#listeners.get(root);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(root, listeners);
    }
    listeners.add(listener);
    for (const request of this.#pending.values())
      if (request.rootConversationId === root) listener({ type: "created", request });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(root);
    };
  }
  async respond(requestId: string, response: QuestionResponse): Promise<void> {
    const request = this.#pending.get(requestId);
    if (!request) return;
    await this.#client.peer.request(questionRespondRequest, {
      conversationId: request.conversationId,
      requestId,
      response,
    });
    this.#remove(request.rootConversationId, requestId);
  }
  #add(request: ClientQuestionRequest): void {
    if (this.#pending.has(request.id)) return;
    this.#pending.set(request.id, request);
    this.#emit(request.rootConversationId, { type: "created", request });
  }
  #remove(root: string, requestId: string): void {
    if (this.#pending.delete(requestId)) this.#emit(root, { type: "resolved", requestId });
  }
  #clear(root: string): void {
    for (const request of this.#pending.values())
      if (request.rootConversationId === root) this.#remove(root, request.id);
  }
  #emit(root: string, event: QuestionClientEvent): void {
    for (const listener of this.#listeners.get(root) ?? []) listener(event);
  }
}
