import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import type {
  ByteRange,
  Clock,
  Conversation,
  ConversationId,
  ContextBuild,
  IdGenerator,
  Item,
  ItemId,
  ModelConfig,
  NewContextBuild,
  NewConversation,
  NewItem,
  OutputRef,
  ProviderPayload,
  SeqRange,
  Store,
  Turn,
  TurnId,
  TurnStatus,
} from "@harness/protocol";
import { itemSchema } from "@harness/protocol";
import { systemClock, uuidIdGenerator } from "@harness/store";
import { migrate, type Database } from "./schema.ts";

type ItemRow = Database["items"];
type AppendParams = {
  id: string;
  conversationId: string;
  turnId: string;
  type: string;
  callId: string | null;
  createdAt: number;
  body: string;
};

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";

/** Durable Store on SQLite (WAL). Passes the same contract suite as `InMemoryStore`. */
export class SqliteStore implements Store {
  readonly #db: BetterSqlite3.Database;
  readonly #k: Kysely<Database>;
  readonly #appendTxn: (p: AppendParams) => { seq: number; parent: string | null };

  constructor(
    path: string,
    private readonly ids: IdGenerator = uuidIdGenerator,
    private readonly clock: Clock = systemClock,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new BetterSqlite3(path);
    this.#db.pragma("foreign_keys = ON"); // off by default — without it the FKs are inert
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = NORMAL");
    this.#db.pragma("busy_timeout = 5000");
    migrate(this.#db);
    this.#k = new Kysely<Database>({ dialect: new SqliteDialect({ database: this.#db }) });
    this.#appendTxn = this.#buildAppendTxn();
  }

  /** Releases the connection (checkpoints WAL). Not in the `Store` interface. */
  close(): void {
    this.#db.close();
  }

  async createConversation(input: NewConversation): Promise<Conversation> {
    const conversation: Conversation = {
      id: this.ids.conversationId(),
      config: input.config,
      head: null,
      createdAt: this.clock.now(),
    };
    await this.#k
      .insertInto("conversations")
      .values({
        id: conversation.id,
        config: JSON.stringify(conversation.config),
        head: null,
        created_at: conversation.createdAt,
      })
      .execute();
    return conversation;
  }

  async getConversation(id: ConversationId): Promise<Conversation | undefined> {
    const row = await this.#k
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToConversation(row) : undefined;
  }

  async updateConversationModel(id: ConversationId, model: ModelConfig): Promise<void> {
    const conversation = await this.getConversation(id);
    if (!conversation) {
      throw new Error(`unknown conversation: ${id}`);
    }
    const config = { ...conversation.config, model };
    await this.#k
      .updateTable("conversations")
      .set({ config: JSON.stringify(config) })
      .where("id", "=", id)
      .execute();
  }

  async listConversations(): Promise<Conversation[]> {
    const rows = await this.#k
      .selectFrom("conversations")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(rowToConversation);
  }

  // Atomic read-then-write of seq/parent + head. Native IMMEDIATE txn (Kysely only issues
  // deferred BEGIN); the upfront write lock stops a second writer racing the head read.
  async appendItem(input: NewItem): Promise<Item> {
    const { conversationId, turnId, type, ...variant } = input;
    const id = this.ids.itemId();
    const createdAt = this.clock.now();
    const { seq, parent } = this.#appendTxn({
      id,
      conversationId,
      turnId,
      type,
      callId: "callId" in input ? input.callId : null,
      createdAt,
      body: JSON.stringify(variant),
    });
    return { ...input, id, seq, parent, createdAt } as Item;
  }

  async listItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]> {
    let q = this.#k
      .selectFrom("items")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy("seq", "asc");
    if (range?.fromSeq !== undefined) q = q.where("seq", ">=", range.fromSeq);
    if (range?.toSeq !== undefined) q = q.where("seq", "<=", range.toSeq);
    return (await q.execute()).map(rowToItem);
  }

  async setHead(conversationId: ConversationId, itemId: ItemId): Promise<void> {
    // EXISTS makes "item belongs to this conversation" the precondition; zero rows updated
    // ⇒ missing conversation or stray item.
    const res = await this.#k
      .updateTable("conversations")
      .set({ head: itemId })
      .where("id", "=", conversationId)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM items WHERE id = ${itemId} AND conversation_id = ${conversationId})`,
      )
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) {
      throw new Error(`item ${itemId} is not in conversation ${conversationId}`);
    }
  }

  async listActiveItems(conversationId: ConversationId): Promise<Item[]> {
    // Parent-walk from head, not a seq-prefix: a rewind-then-continue leaves the active
    // chain a non-contiguous subset of seq. Empty when head IS NULL.
    const rows = await sql<ItemRow>`
      WITH RECURSIVE chain(id) AS (
        SELECT head FROM conversations WHERE id = ${conversationId}
        UNION ALL
        SELECT items.parent FROM items JOIN chain ON items.id = chain.id
        WHERE items.parent IS NOT NULL
      )
      SELECT i.* FROM items i JOIN chain ON i.id = chain.id ORDER BY i.seq ASC
    `.execute(this.#k);
    return rows.rows.map(rowToItem);
  }

  async createTurn(conversationId: ConversationId): Promise<Turn> {
    const turn: Turn = {
      id: this.ids.turnId(),
      conversationId,
      status: "running",
      createdAt: this.clock.now(),
    };
    try {
      await this.#k
        .insertInto("turns")
        .values({
          id: turn.id,
          conversation_id: conversationId,
          status: "running",
          created_at: turn.createdAt,
        })
        .execute();
    } catch (e) {
      // Partial unique index (one running turn per conversation) is the race-free guard.
      if (isUniqueViolation(e)) {
        throw new Error(`conversation ${conversationId} already has a running turn`, { cause: e });
      }
      throw e;
    }
    return turn;
  }

  async updateTurn(id: TurnId, status: TurnStatus): Promise<Turn> {
    const row = await this.#k
      .updateTable("turns")
      .set({ status })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error(`unknown turn: ${id}`);
    return rowToTurn(row);
  }

  async getActiveTurn(conversationId: ConversationId): Promise<Turn | undefined> {
    const row = await this.#k
      .selectFrom("turns")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("status", "=", "running")
      .executeTakeFirst();
    return row ? rowToTurn(row) : undefined;
  }

  async recordContextBuild(input: NewContextBuild): Promise<ContextBuild> {
    const build: ContextBuild = { ...input, id: randomUUID(), createdAt: this.clock.now() };
    await this.#k
      .insertInto("context_builds")
      .values({
        id: build.id,
        conversation_id: input.conversationId,
        created_at: build.createdAt,
        data: JSON.stringify(input),
      })
      .execute();
    return build;
  }

  async putProviderPayload(payload: ProviderPayload): Promise<void> {
    const values = {
      item_id: payload.itemId,
      provider: payload.provider,
      model: payload.model,
      type: payload.type,
      version: payload.version,
      payload: JSON.stringify(payload.payload),
    };
    await this.#k
      .insertInto("provider_payloads")
      .values(values)
      .onConflict((oc) => oc.column("item_id").doUpdateSet(values))
      .execute();
  }

  async getProviderPayloads(itemIds: ItemId[]): Promise<ProviderPayload[]> {
    if (itemIds.length === 0) return [];
    const rows = await this.#k
      .selectFrom("provider_payloads")
      .selectAll()
      .where("item_id", "in", itemIds)
      .execute();
    const byId = new Map(rows.map((r) => [r.item_id, r]));
    // Preserve input order; skip missing (in-memory parity).
    const out: ProviderPayload[] = [];
    for (const id of itemIds) {
      const r = byId.get(id);
      if (r) {
        out.push({
          itemId: r.item_id as ItemId,
          provider: r.provider,
          model: r.model,
          type: r.type,
          version: r.version,
          payload: JSON.parse(r.payload) as unknown,
        });
      }
    }
    return out;
  }

  async putPluginState(
    plugin: string,
    conversationId: ConversationId,
    key: string,
    value: unknown,
  ): Promise<void> {
    const json = JSON.stringify(value);
    await this.#k
      .insertInto("plugin_state")
      .values({ plugin, conversation_id: conversationId, key, value: json })
      .onConflict((oc) =>
        oc.columns(["plugin", "conversation_id", "key"]).doUpdateSet({ value: json }),
      )
      .execute();
  }

  async getPluginState(
    plugin: string,
    conversationId: ConversationId,
    key: string,
  ): Promise<unknown> {
    const row = await this.#k
      .selectFrom("plugin_state")
      .select("value")
      .where("plugin", "=", plugin)
      .where("conversation_id", "=", conversationId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  async putBlob(bytes: Uint8Array): Promise<OutputRef> {
    const id = randomUUID();
    await this.#k
      .insertInto("blobs")
      .values({ id, content_type: "application/octet-stream", data: Buffer.from(bytes) })
      .execute();
    return { id, bytes: bytes.byteLength, contentType: "application/octet-stream" };
  }

  async getBlob(ref: OutputRef, range?: ByteRange): Promise<Uint8Array> {
    const row = await this.#k
      .selectFrom("blobs")
      .select("data")
      .where("id", "=", ref.id)
      .executeTakeFirst();
    if (!row) throw new Error(`unknown blob: ${ref.id}`);
    const data = row.data;
    if (!range) return Uint8Array.from(data);
    return Uint8Array.from(data.subarray(range.offset, range.offset + range.length));
  }

  #buildAppendTxn(): (p: AppendParams) => { seq: number; parent: string | null } {
    const head = this.#db.prepare<[string], { head: string | null }>(
      "SELECT head FROM conversations WHERE id = ?",
    );
    const maxSeq = this.#db.prepare<[string], { m: number | null }>(
      "SELECT MAX(seq) AS m FROM items WHERE conversation_id = ?",
    );
    const insert = this.#db.prepare(
      `INSERT INTO items (id, conversation_id, seq, turn_id, parent, type, call_id, created_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const advanceHead = this.#db.prepare("UPDATE conversations SET head = ? WHERE id = ?");
    const txn = this.#db.transaction((p: AppendParams) => {
      const conv = head.get(p.conversationId);
      if (!conv) throw new Error(`unknown conversation: ${p.conversationId}`);
      const max = maxSeq.get(p.conversationId);
      const seq = max?.m == null ? 0 : max.m + 1;
      const parent = conv.head;
      insert.run(
        p.id,
        p.conversationId,
        seq,
        p.turnId,
        parent,
        p.type,
        p.callId,
        p.createdAt,
        p.body,
      );
      advanceHead.run(p.id, p.conversationId);
      return { seq, parent };
    });
    return (p) => txn.immediate(p);
  }
}

function rowToItem(row: ItemRow): Item {
  return itemSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    seq: row.seq,
    parent: row.parent,
    createdAt: row.created_at,
    type: row.type,
    ...(JSON.parse(row.body) as object),
  }) as Item;
}

function rowToConversation(row: Database["conversations"]): Conversation {
  return {
    id: row.id as ConversationId,
    config: JSON.parse(row.config) as Conversation["config"],
    head: row.head as ItemId | null,
    createdAt: row.created_at,
  };
}

function rowToTurn(row: Database["turns"]): Turn {
  return {
    id: row.id as TurnId,
    conversationId: row.conversation_id as ConversationId,
    status: row.status as TurnStatus,
    createdAt: row.created_at,
  };
}
