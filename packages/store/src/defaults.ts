import { randomUUID } from "node:crypto";
import type { Clock, ConversationId, IdGenerator, ItemId, TurnId } from "@harness/protocol";

export const uuidIdGenerator: IdGenerator = {
  conversationId: () => randomUUID() as ConversationId,
  turnId: () => randomUUID() as TurnId,
  itemId: () => randomUUID() as ItemId,
};

export const systemClock: Clock = { now: () => Date.now() };
