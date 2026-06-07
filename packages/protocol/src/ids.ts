declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ConversationId = Brand<string, "ConversationId">;
export type TurnId = Brand<string, "TurnId">;
export type ItemId = Brand<string, "ItemId">;

/** Mints ids for durable records. Injected so tests can make ids deterministic. */
export interface IdGenerator {
  conversationId(): ConversationId;
  turnId(): TurnId;
  itemId(): ItemId;
}

/** Wall-clock source for record timestamps. Injected so tests can fix time. */
export interface Clock {
  now(): number; // epoch milliseconds
}
