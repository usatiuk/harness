import type { Clock, ConversationId, IdGenerator, ItemId, TurnId } from "@harness/protocol";

/** Sequential, prefixed ids so tests can assert exact values. */
export function counterIdGenerator(prefix = ""): IdGenerator {
  let c = 0;
  let t = 0;
  let i = 0;
  return {
    conversationId: () => `${prefix}c${++c}` as ConversationId,
    turnId: () => `${prefix}t${++t}` as TurnId,
    itemId: () => `${prefix}i${++i}` as ItemId,
  };
}

/** Monotonic clock starting at `start`, advancing one tick per read. */
export function fixedClock(start = 0): Clock {
  let n = start;
  return { now: () => n++ };
}
