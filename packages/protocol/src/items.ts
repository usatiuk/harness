import { z } from "zod";
import type { ConversationId, ItemId, TurnId } from "./ids.ts";
import { contentBlockSchema, type ContentBlock } from "./content.ts";
import type { ToolStatus } from "./tools.ts";

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
  | (ItemBase & { type: "message"; role: MessageRole; content: ContentBlock[] })
  | (ItemBase & { type: "reasoning"; content: ContentBlock[] })
  | (ItemBase & { type: "tool_call"; callId: string; name: string; args: unknown })
  | (ItemBase & {
      type: "tool_result";
      callId: string;
      content: ContentBlock[];
      status: ToolStatus;
    })
  // A fold of everything before it (appended at head, so its position marks the
  // coverage). Renders to the provider as a plain message; the `compaction` type is
  // a kernel marker so context-build can bound the window at it.
  | (ItemBase & { type: "compaction"; content: ContentBlock[] });

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

/** Validates the structural shape; branded ids are cast at the parse site. */
export const itemSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseShape,
    type: z.literal("message"),
    role: z.enum(["user", "assistant", "system"]),
    content: z.array(contentBlockSchema),
  }),
  z.object({
    ...baseShape,
    type: z.literal("reasoning"),
    content: z.array(contentBlockSchema),
  }),
  z.object({
    ...baseShape,
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    args: z.unknown(),
  }),
  z.object({
    ...baseShape,
    type: z.literal("tool_result"),
    callId: z.string(),
    content: z.array(contentBlockSchema),
    status: z.enum(["ok", "error"]),
  }),
  z.object({
    ...baseShape,
    type: z.literal("compaction"),
    content: z.array(contentBlockSchema),
  }),
]);
