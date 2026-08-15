import { z } from "zod";
import { defineRequest, jsonValueSchema } from "@harness/protocol";
import type { RpcPeer } from "@harness/client";

export const APPROVAL_CLIENT_CONTRACT_VERSION = 1;

export const approvalDecideRequest = defineRequest({
  direction: "server-to-client",
  method: "plugin.approval.decide",
  params: z.strictObject({
    requestId: z.string(),
    rootConversationId: z.string(),
    conversationId: z.string(),
    call: z.strictObject({
      callId: z.string(),
      name: z.string(),
      args: jsonValueSchema,
    }),
    relationship: z.enum(["in-workspace", "out-of-workspace", "unknown"]),
  }),
  result: z.strictObject({ decision: z.enum(["allow", "deny"]) }),
});

export type ClientApproval = z.infer<typeof approvalDecideRequest.params>;
export type ApprovalClientEvent =
  | { type: "created"; approval: ClientApproval }
  | { type: "resolved"; requestId: string };

/** Connection-wide owner for approval requests, independent of the visible screen. */
export class ApprovalClient {
  readonly #pending = new Map<
    string,
    { approval: ClientApproval; resolve: (decision: "allow" | "deny") => void }
  >();
  readonly #listeners = new Map<string, Set<(event: ApprovalClientEvent) => void>>();

  constructor(peer: RpcPeer) {
    peer.onRequest(approvalDecideRequest, (approval, signal) => {
      if (signal.aborted) throw new Error("approval request cancelled");
      if (this.#pending.has(approval.requestId)) {
        throw new Error(`duplicate approval request '${approval.requestId}'`);
      }
      return new Promise((resolve, reject) => {
        const finish = (): void => {
          this.#pending.delete(approval.requestId);
          this.#emit(approval.rootConversationId, {
            type: "resolved",
            requestId: approval.requestId,
          });
        };
        const onAbort = (): void => {
          finish();
          reject(new Error("approval request cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.#pending.set(approval.requestId, {
          approval,
          resolve: (decision) => {
            signal.removeEventListener("abort", onAbort);
            finish();
            resolve({ decision });
          },
        });
        this.#emit(approval.rootConversationId, { type: "created", approval });
      });
    });
  }

  subscribe(
    rootConversationId: string,
    listener: (event: ApprovalClientEvent) => void,
  ): () => void {
    let listeners = this.#listeners.get(rootConversationId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(rootConversationId, listeners);
    }
    listeners.add(listener);
    for (const { approval } of this.#pending.values()) {
      if (approval.rootConversationId === rootConversationId) {
        listener({ type: "created", approval });
      }
    }
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(rootConversationId);
    };
  }

  respond(requestId: string, decision: "allow" | "deny"): void {
    this.#pending.get(requestId)?.resolve(decision);
  }

  #emit(rootConversationId: string, event: ApprovalClientEvent): void {
    for (const listener of this.#listeners.get(rootConversationId) ?? []) listener(event);
  }
}
