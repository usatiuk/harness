import { z } from "zod";
import type { ConversationId, ItemId, TurnId } from "./ids.ts";
import { contentBlockSchema, type ContentBlock } from "./content.ts";
import { outputRefSchema, type ToolStatus, type OutputRef } from "./tools.ts";
import { jsonValueSchema, type JsonValue } from "./rpc.ts";
import { deliverySourceSchema, type DeliverySource } from "./delivery.ts";

interface ItemBase {
  id: ItemId;
  conversationId: ConversationId;
  turnId: TurnId;
  seq: number; // monotonic per conversation; assigned by the store on append
  parent: ItemId | null; // prior head at append time; null for the first item
  createdAt: number; // epoch ms; assigned by the store on append
}

export type MessageRole = "user" | "assistant" | "system";

/** Immutable canonical log entry. The conversation owns one ordered list of these. */
export type Item =
  | (ItemBase & {
      type: "message";
      content: ContentBlock[];
    } & (
        | { role: "assistant"; phase?: string | null }
        // Absent on older history; origin does not change the model-facing role.
        | { role: "user"; source?: DeliverySource; phase?: never }
        | { role: "system"; phase?: never }
      ))
  | (ItemBase & { type: "reasoning"; content: ContentBlock[] })
  // Durable display hint only; omitted from every model request and summary.
  | (ItemBase & { type: "provider_output"; content: ContentBlock[] })
  | (ItemBase & {
      type: "tool_call";
      callId: string;
      name: string;
      args: unknown;
      parentCallId?: string;
    })
  | (ItemBase & {
      type: "tool_result";
      callId: string;
      parentCallId?: string;
      content: ContentBlock[];
      status: ToolStatus;
      annotations?: Record<string, unknown>;
      structured?: JsonValue;
      structuredRef?: OutputRef;
      full?: OutputRef;
    })
  // A fold of the complete active history before it. Renders to the provider as a
  // plain message; its position is the context boundary.
  | (ItemBase & { type: "compaction"; content: ContentBlock[] })
  // Plugin-injected durable context (e.g. a nested AGENTS.md), staged by tool middleware and
  // appended after the paired result. `key` is an opaque dedup identity the kernel never reads.
  // Renders to the provider as a plain message.
  | (ItemBase & { type: "context"; content: ContentBlock[]; key: string });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Input to append: the store assigns `id`, `seq`, `parent`, and `createdAt`. */
export type NewItem = DistributiveOmit<Item, "id" | "seq" | "parent" | "createdAt">;

const baseShape = {
  id: z.string(),
  conversationId: z.string(),
  turnId: z.string(),
  seq: z.number().int().nonnegative(),
  parent: z.string().nullable(),
  createdAt: z.number().int(),
};

const messageShape = {
  ...baseShape,
  type: z.literal("message"),
  content: z.array(contentBlockSchema),
};

/** Validates the structural shape; branded ids are cast at the parse site. */
export const itemSchema = z.discriminatedUnion("type", [
  z.discriminatedUnion("role", [
    z.object({
      ...messageShape,
      role: z.literal("assistant"),
      phase: z.string().nullable().optional(),
    }),
    z.object({
      ...messageShape,
      role: z.literal("user"),
      source: deliverySourceSchema.optional(),
      phase: z.never().optional(),
    }),
    z.object({
      ...messageShape,
      role: z.literal("system"),
      phase: z.never().optional(),
    }),
  ]),
  z.object({
    ...baseShape,
    type: z.literal("reasoning"),
    content: z.array(contentBlockSchema),
  }),
  z.object({
    ...baseShape,
    type: z.literal("provider_output"),
    content: z.array(contentBlockSchema),
  }),
  z.object({
    ...baseShape,
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    args: z.unknown(),
    parentCallId: z.string().optional(),
  }),
  z.object({
    ...baseShape,
    type: z.literal("tool_result"),
    callId: z.string(),
    content: z.array(contentBlockSchema),
    parentCallId: z.string().optional(),
    status: z.enum(["ok", "error"]),
    annotations: z.record(z.string(), z.unknown()).optional(),
    structured: jsonValueSchema.optional(),
    structuredRef: outputRefSchema.optional(),
    full: outputRefSchema.optional(),
  }),
  z.object({
    ...baseShape,
    type: z.literal("compaction"),
    content: z.array(contentBlockSchema),
  }),
  z.object({
    ...baseShape,
    type: z.literal("context"),
    content: z.array(contentBlockSchema),
    key: z.string(),
  }),
]);

/** Provider call IDs are unique only within the conversation that created them. */
export const toolCallKey = (call: { conversationId: string; callId: string }): string =>
  JSON.stringify([call.conversationId, call.callId]);
