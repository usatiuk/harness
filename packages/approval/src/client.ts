import { z } from "zod";
import { defineRequest, defineNotification, jsonValueSchema } from "@harness/protocol";
import type { HarnessClient } from "@harness/client";

export const APPROVAL_CLIENT_CONTRACT_VERSION = 3;
export const clientApprovalSchema = z.strictObject({
  requestId: z.string(),
  rootConversationId: z.string(),
  conversationId: z.string(),
  call: z.strictObject({ callId: z.string(), name: z.string(), args: jsonValueSchema }),
  relationship: z.enum(["in-workspace", "out-of-workspace", "unknown"]).nullable(),
});
export const approvalsSnapshotSchema = z.strictObject({ pending: z.array(clientApprovalSchema) });
export const approvalCreatedNotification = defineNotification({
  direction: "server-to-client",
  method: "plugin.approval.created",
  params: clientApprovalSchema,
});
export const approvalResolvedNotification = defineNotification({
  direction: "server-to-client",
  method: "plugin.approval.resolved",
  params: z.strictObject({ rootConversationId: z.string(), requestId: z.string() }),
});
export const approvalDecideRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.approval.decide",
  params: z.strictObject({
    conversationId: z.string(),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
  }),
  result: z.strictObject({ resolved: z.boolean() }),
});
export type ClientApproval = z.infer<typeof clientApprovalSchema>;
export type ApprovalClientEvent =
  { type: "created"; approval: ClientApproval } | { type: "resolved"; requestId: string };

/** A view of server-owned pending approvals, independent of the visible screen. */
export class ApprovalClient {
  readonly #client: HarnessClient;
  readonly #pending = new Map<string, ClientApproval>();
  readonly #listeners = new Map<string, Set<(event: ApprovalClientEvent) => void>>();
  constructor(client: HarnessClient) {
    this.#client = client;
    client.subscribe((event) => {
      if (event.type === "detached") this.#clear(event.rootConversationId);
      if (event.type !== "attached") return;
      const root = event.attachment.root.id;
      this.#clear(root);
      for (const approval of approvalsSnapshotSchema.parse(
        event.attachment.plugins["approval"] ?? { pending: [] },
      ).pending)
        this.#add(approval);
    });
    client.peer.onNotification(approvalCreatedNotification, (approval) => {
      client.receive(approval.rootConversationId, approval, () => this.#add(approval));
    });
    client.peer.onNotification(approvalResolvedNotification, (params) => {
      client.receive(params.rootConversationId, params, () =>
        this.#remove(params.rootConversationId, params.requestId),
      );
    });
  }
  subscribe(root: string, listener: (event: ApprovalClientEvent) => void): () => void {
    let listeners = this.#listeners.get(root);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(root, listeners);
    }
    listeners.add(listener);
    for (const approval of this.#pending.values())
      if (approval.rootConversationId === root) listener({ type: "created", approval });
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(root);
    };
  }
  async respond(requestId: string, decision: "allow" | "deny"): Promise<void> {
    const approval = this.#pending.get(requestId);
    if (approval === undefined) return;
    await this.#client.peer.request(approvalDecideRequest, {
      requestId,
      conversationId: approval.conversationId,
      decision,
    });
    this.#remove(approval.rootConversationId, requestId);
  }
  #add(approval: ClientApproval): void {
    if (this.#pending.has(approval.requestId)) return;
    this.#pending.set(approval.requestId, approval);
    this.#emit(approval.rootConversationId, { type: "created", approval });
  }
  #remove(root: string, requestId: string): void {
    if (this.#pending.delete(requestId)) this.#emit(root, { type: "resolved", requestId });
  }
  #clear(root: string): void {
    for (const approval of this.#pending.values())
      if (approval.rootConversationId === root) this.#remove(root, approval.requestId);
  }
  #emit(root: string, event: ApprovalClientEvent): void {
    for (const listener of this.#listeners.get(root) ?? []) listener(event);
  }
}
