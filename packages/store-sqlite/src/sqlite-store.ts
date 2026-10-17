import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import type {
  ManagedWorktree,
  ByteRange,
  Clock,
  ConversationPageCursor,
  ConversationListOptions,
  ConversationProject,
  ConversationProjectCursor,
  ConversationId,
  ConversationOverrides,
  ConversationRecord,
  ContextBuild,
  IdGenerator,
  Item,
  ItemId,
  ModelUsage,
  ModelUsageSummary,
  NewContextBuild,
  NewConversationRecord,
  NewItem,
  NewModelUsage,
  OutputRef,
  ProviderPayload,
  SeqRange,
  Store,
  Turn,
  TurnId,
  TurnStatus,
  Usage,
} from "@harness/protocol";
import {
  addUsage,
  itemSchema,
  usageSchema,
  zeroUsage,
  summarizeTurnUsage,
  jsonValueSchema,
} from "@harness/protocol";
import { systemClock, uuidIdGenerator } from "@harness/store";
import { initializeSchema, type Database } from "./schema.ts";

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
  readonly #updateOverridesTxn: (id: string, patch: ConversationOverrides) => void;

  constructor(
    path: string,
    private readonly ids: IdGenerator = uuidIdGenerator,
    private readonly clock: Clock = systemClock,
    options:
      | { exclusive: true; beforeInitialize?: () => void }
      | { exclusive?: false; beforeInitialize?: never } = {},
  ) {
    if (options.beforeInitialize !== undefined && !options.exclusive)
      throw new Error("The pre-initialization hook requires exclusive SQLite ownership");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new BetterSqlite3(path);
    try {
      this.#db.pragma(`busy_timeout = ${options.exclusive ? 0 : 5000}`);
      if (options.exclusive) {
        // Acquire before schema initialization or starting runtime resources; the OS releases
        // SQLite's lock even if the owning process crashes.
        this.#db.pragma("locking_mode = EXCLUSIVE");
        this.#db.exec("BEGIN EXCLUSIVE; COMMIT;");
      }
      // Selection and future migration backup policy stay outside the store.
      // A rejected candidate cannot initialize or migrate this database.
      options.beforeInitialize?.();
      this.#db.pragma("foreign_keys = ON");
      // Reject an unsupported format before changing persistent journal mode.
      initializeSchema(this.#db);
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = NORMAL");
    } catch (error) {
      this.#db.close();
      if (options.exclusive && (error as { code?: string }).code === "SQLITE_BUSY") {
        throw new Error(`Harness database is already in use by another server: ${path}`, {
          cause: error,
        });
      }
      throw error;
    }
    this.#k = new Kysely<Database>({ dialect: new SqliteDialect({ database: this.#db }) });
    this.#appendTxn = this.#buildAppendTxn();
    this.#updateOverridesTxn = this.#buildUpdateOverridesTxn();
  }

  /** Releases the connection (checkpoints WAL). Not in the `Store` interface. */
  close(): void {
    this.#db.close();
  }

  async putManagedWorktree(tree: ManagedWorktree): Promise<void> {
    await this.#k
      .insertInto("managed_worktrees")
      .values({ path: tree.path, repository: tree.repository, created_at: tree.createdAt })
      .execute();
  }
  async getManagedWorktree(path: string): Promise<ManagedWorktree | undefined> {
    const row = await this.#k
      .selectFrom("managed_worktrees")
      .selectAll()
      .where("path", "=", path)
      .executeTakeFirst();
    return row
      ? { path: row.path, repository: row.repository, createdAt: row.created_at }
      : undefined;
  }
  async listManagedWorktrees(limit: number, before?: string): Promise<ManagedWorktree[]> {
    let query = this.#k.selectFrom("managed_worktrees").selectAll().orderBy("path").limit(limit);
    if (before) query = query.where("path", ">", before);
    return (await query.execute()).map((row) => ({
      path: row.path,
      repository: row.repository,
      createdAt: row.created_at,
    }));
  }
  async deleteManagedWorktree(path: string): Promise<void> {
    await this.#k.deleteFrom("managed_worktrees").where("path", "=", path).execute();
  }

  async createConversation(input: NewConversationRecord): Promise<ConversationRecord> {
    const createdAt = this.clock.now();
    const record: ConversationRecord = {
      id: this.ids.conversationId(),
      workspaceRoot: input.workspaceRoot,
      ...(input.originalWorkspaceRoot
        ? { originalWorkspaceRoot: input.originalWorkspaceRoot }
        : {}),
      overrides: input.overrides,
      head: null,
      title: null,
      createdAt,
      lastUsedAt: createdAt,
    };
    await this.#k
      .insertInto("conversations")
      .values({
        id: record.id,
        workspace_root: record.workspaceRoot,
        original_workspace_root: record.originalWorkspaceRoot ?? null,
        overrides: JSON.stringify(record.overrides),
        head: null,
        title: null,
        created_at: record.createdAt,
        last_used_at: record.lastUsedAt,
        fork_origin: null,
      })
      .execute();
    return record;
  }

  async forkConversation(
    sourceId: ConversationId,
    userMessageId: ItemId,
    overrides: ConversationOverrides,
  ): Promise<ConversationRecord> {
    return this.#db
      .transaction(() => {
        const source = this.#db
          .prepare<[string], Database["conversations"]>("SELECT * FROM conversations WHERE id = ?")
          .get(sourceId);
        if (!source) throw new Error(`unknown conversation: ${sourceId}`);
        const row = this.#db
          .prepare<[string], ItemRow>("SELECT * FROM items WHERE id = ?")
          .get(userMessageId);
        const user = row ? rowToItem(row) : undefined;
        if (user?.type !== "message" || user.role !== "user")
          throw new Error("fork target must be a user message");
        const createdAt = this.clock.now();
        const record: ConversationRecord = {
          id: this.ids.conversationId(),
          workspaceRoot: source.workspace_root,
          ...(source.original_workspace_root
            ? { originalWorkspaceRoot: source.original_workspace_root }
            : {}),
          overrides,
          head: user.parent,
          title: source.title,
          createdAt,
          lastUsedAt: createdAt,
          fork: { conversationId: sourceId, userMessageId },
        };
        this.#db
          .prepare(
            `INSERT INTO conversations (id, workspace_root, overrides, head, title, created_at, last_used_at, fork_origin, original_workspace_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.workspaceRoot,
            JSON.stringify(overrides),
            record.head,
            record.title,
            createdAt,
            createdAt,
            JSON.stringify(record.fork),
            record.originalWorkspaceRoot ?? null,
          );
        return record;
      })
      .immediate();
  }

  async updateConversationTitle(
    id: ConversationId,
    title: string,
    expected: string | null,
  ): Promise<boolean> {
    const result = await this.#k
      .updateTable("conversations")
      .set({ title })
      .where("id", "=", id)
      .where("title", expected === null ? "is" : "=", expected)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n && !(await this.getConversation(id)))
      throw new Error(`unknown conversation: ${id}`);
    return result.numUpdatedRows > 0n;
  }

  async updateConversationWorkspace(
    id: ConversationId,
    workspaceRoot: string,
  ): Promise<ConversationRecord> {
    const result = this.#db
      .prepare(
        `UPDATE conversations
      SET original_workspace_root = COALESCE(original_workspace_root, workspace_root), workspace_root = ?
      WHERE id = ? AND workspace_root IS NOT NULL RETURNING *`,
      )
      .get(workspaceRoot, id) as Database["conversations"] | undefined;
    if (!result) throw new Error(`Unknown or projectless conversation: ${id}`);
    return rowToRecord(result);
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
    const row = await this.#k
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToRecord(row) : undefined;
  }

  async deleteConversationIfEmpty(id: ConversationId): Promise<void> {
    await this.#k
      .deleteFrom("conversations")
      .where("id", "=", id)
      .where("head", "is", null)
      .where("id", "not in", (eb) => eb.selectFrom("turns").select("conversation_id"))
      .execute();
  }

  async updateConversationOverrides(
    id: ConversationId,
    patch: ConversationOverrides,
  ): Promise<void> {
    this.#updateOverridesTxn(id, patch);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const rows = await this.#k
      .selectFrom("conversations")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(rowToRecord);
  }

  async listConversationPage(
    limit: number,
    before?: ConversationPageCursor,
    options: ConversationListOptions = {},
  ): Promise<ConversationRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    const recent = options.order === "lastUsed";
    if (before && recent !== "lastUsedAt" in before) throw new Error("cursor order mismatch");
    const column = recent ? "last_used_at" : "created_at";
    let query = this.#k.selectFrom("conversations").selectAll();
    if (options.includedState) {
      const { plugin, key, scope } = options.includedState;
      query = query.where(
        "id",
        "in",
        this.#k
          .selectFrom("plugin_state")
          .select("conversation_id")
          .where("plugin", "=", plugin)
          .where("key", "=", key)
          .where("scope", "=", scope),
      );
    }
    if (options.excludedState) {
      const { plugin, key } = options.excludedState;
      query = query.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("plugin_state")
              .select("conversation_id")
              .whereRef("plugin_state.conversation_id", "=", "conversations.id")
              .where("plugin", "=", plugin)
              .where("key", "=", key),
          ),
        ),
      );
    }
    if (options.workspaceRoot !== undefined)
      query = query.where(
        "workspace_root",
        options.workspaceRoot === null ? "is" : "=",
        options.workspaceRoot,
      );
    if (options.projectRoot !== undefined)
      query = query.where(
        sql<string>`coalesce(original_workspace_root, workspace_root)`,
        "=",
        options.projectRoot,
      );
    if (before) {
      const cutoff = "lastUsedAt" in before ? before.lastUsedAt : before.createdAt;
      query = query.where((eb) =>
        eb.or([
          eb(column, "<", cutoff),
          eb.and([eb(column, "=", cutoff), eb("id", "<", before.id)]),
        ]),
      );
    }
    return (await query.orderBy(column, "desc").orderBy("id", "desc").limit(limit).execute()).map(
      rowToRecord,
    );
  }

  recordUserInput(id: ConversationId): number {
    const lastUsedAt = this.clock.now();
    const result = this.#db
      .prepare("UPDATE conversations SET last_used_at = ? WHERE id = ?")
      .run(lastUsedAt, id);
    if (result.changes === 0) throw new Error(`unknown conversation: ${id}`);
    return lastUsedAt;
  }

  async listConversationProjects(
    limit: number,
    before?: ConversationProjectCursor,
    excludedState?: { plugin: string; key: string },
  ): Promise<ConversationProject[]> {
    const projectRoot = "coalesce(original_workspace_root, workspace_root)";
    const query = `SELECT ${projectRoot} AS workspaceRoot, MAX(last_used_at) AS lastUsedAt
      FROM conversations AS c WHERE workspace_root IS NOT NULL
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM plugin_state AS p WHERE p.conversation_id = c.id AND p.plugin = ? AND p.key = ?))
      GROUP BY ${projectRoot}
      HAVING ? IS NULL OR MAX(last_used_at) < ? OR (MAX(last_used_at) = ? AND ${projectRoot} < ?)
      ORDER BY lastUsedAt DESC, ${projectRoot} DESC LIMIT ?`;
    return this.#db
      .prepare(query)
      .all(
        excludedState?.plugin ?? null,
        excludedState?.plugin ?? null,
        excludedState?.key ?? null,
        before?.lastUsedAt ?? null,
        before?.lastUsedAt ?? null,
        before?.lastUsedAt ?? null,
        before?.workspaceRoot ?? null,
        limit,
      ) as ConversationProject[];
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

  async listOwnedItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]> {
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
    const res = await this.#k
      .updateTable("conversations")
      .set({ head: itemId })
      .where("id", "=", conversationId)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM items WHERE id = ${itemId})`)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) {
      throw new Error(`unknown conversation or item: ${conversationId}/${itemId}`);
    }
  }

  async listActiveItems(conversationId: ConversationId): Promise<Item[]> {
    // Parent-walk from head, not a seq-prefix: a rewind-then-continue leaves the active
    // chain a non-contiguous subset of seq. Empty when head IS NULL.
    const rows = await sql<ItemRow>`
      WITH RECURSIVE chain(id, depth) AS (
        SELECT head, 0 FROM conversations WHERE id = ${conversationId}
        UNION ALL
        SELECT items.parent, chain.depth + 1 FROM items JOIN chain ON items.id = chain.id
        WHERE items.parent IS NOT NULL
      )
      SELECT i.* FROM items i JOIN chain ON i.id = chain.id ORDER BY chain.depth DESC
    `.execute(this.#k);
    return rows.rows.map(rowToItem);
  }

  async getItem(itemId: ItemId): Promise<Item | undefined> {
    const row = await this.#k
      .selectFrom("items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirst();
    return row ? rowToItem(row) : undefined;
  }

  async listItemAncestors(start: ItemId | null, limit: number): Promise<Item[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    if (start === null) return [];
    const rows = await sql<ItemRow>`
      WITH RECURSIVE chain(id, depth) AS (
        SELECT id, 0 FROM items
        WHERE id = ${start}
        UNION ALL
        SELECT items.parent, chain.depth + 1
        FROM items JOIN chain ON items.id = chain.id
        WHERE items.parent IS NOT NULL AND chain.depth + 1 < ${limit}
      )
      SELECT i.* FROM items i JOIN chain ON i.id = chain.id ORDER BY chain.depth ASC
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

  async getLatestTurn(conversationId: ConversationId): Promise<Turn | undefined> {
    const row = await this.#k
      .selectFrom("turns")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy(sql<number>`turns.rowid`, "desc")
      .limit(1)
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

  async getContextBuild(id: string): Promise<ContextBuild | undefined> {
    const row = await this.#k
      .selectFrom("context_builds")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.data) as NewContextBuild),
      id: row.id,
      createdAt: row.created_at,
    };
  }

  async recordModelUsage(input: NewModelUsage): Promise<ModelUsage> {
    const record: ModelUsage = { ...input, id: randomUUID(), createdAt: this.clock.now() };
    await this.#k
      .insertInto("model_usage")
      .values({
        id: record.id,
        conversation_id: input.conversationId,
        turn_id: input.turnId,
        context_build_id: input.contextBuildId,
        provider: input.provider,
        model: input.model,
        purpose: input.purpose ?? null,
        request_duration_ms: input.requestDurationMs ?? null,
        usage: JSON.stringify(input.usage),
        cost: input.cost,
        provider_usage:
          input.providerUsage === undefined ? null : JSON.stringify(input.providerUsage),
        cost_incomplete: input.costIncomplete ? 1 : 0,
        input_tokens_are_context: input.inputTokensAreContext === false ? 0 : 1,
        created_at: record.createdAt,
      })
      .execute();
    return record;
  }

  async listModelUsage(conversationId: ConversationId): Promise<ModelUsage[]> {
    // rowid tiebreak: created_at has only ms resolution.
    const rows = await this.#k
      .selectFrom("model_usage")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "asc")
      .orderBy(sql`rowid`, "asc")
      .execute();
    return rows.map(rowToModelUsage);
  }

  async summarizeModelUsage(conversationId: ConversationId): Promise<ModelUsageSummary> {
    const rows = this.#db
      .prepare<
        [string],
        {
          usage: string;
          cost: number | null;
          cost_incomplete: number;
          input_tokens_are_context: number;
        }
      >(
        `SELECT usage, cost, cost_incomplete, input_tokens_are_context FROM model_usage
         WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .iterate(conversationId);
    let usage = zeroUsage();
    let incomplete = false;
    let cost = 0;
    let costIncomplete = false;
    let lastInputTokens: number | undefined;
    for (const row of rows) {
      cost += row.cost ?? 0;
      costIncomplete ||= row.cost === null || row.cost_incomplete === 1;
      const parsed = usageSchema.nullable().parse(JSON.parse(row.usage)) as Usage | null;
      if (parsed === null) {
        incomplete = true;
      } else {
        usage = addUsage(usage, parsed);
        lastInputTokens = parsed.inputTokens;
      }
      if (row.input_tokens_are_context === 0) lastInputTokens = undefined;
    }
    const agent = this.#db
      .prepare<[string], Database["model_usage"]>(
        `SELECT * FROM model_usage WHERE conversation_id = ? AND purpose = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(conversationId);
    const terminal = this.#db
      .prepare<[string], Database["turns"]>(
        `SELECT * FROM turns WHERE conversation_id = ? AND status <> 'running' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(conversationId);
    const turnRows = terminal
      ? this.#db
          .prepare<[string], Database["model_usage"]>(`SELECT * FROM model_usage WHERE turn_id = ?`)
          .all(terminal.id)
          .map(rowToModelUsage)
      : [];
    return {
      usage,
      incomplete,
      cost,
      costIncomplete,
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
      ...(agent
        ? {
            agentContext: {
              provider: agent.provider,
              model: agent.model,
              turnId: agent.turn_id as TurnId,
              usage: agent.input_tokens_are_context === 0 ? null : rowToModelUsage(agent).usage,
              createdAt: agent.created_at,
            },
          }
        : {}),
      ...(terminal ? { lastTurn: summarizeTurnUsage(rowToTurn(terminal), turnRows) } : {}),
    };
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
    scope?: string,
  ): Promise<void> {
    const json = JSON.stringify(value);
    await this.#k
      .insertInto("plugin_state")
      .values({ plugin, conversation_id: conversationId, key, value: json, scope: scope ?? null })
      .onConflict((oc) =>
        oc
          .columns(["plugin", "conversation_id", "key"])
          .doUpdateSet({ value: json, ...(scope === undefined ? {} : { scope }) }),
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
      .select(
        range
          ? sql<Uint8Array>`substr(data, ${range.offset + 1}, ${range.length})`.as("data")
          : "data",
      )
      .where("id", "=", ref.id)
      .executeTakeFirst();
    if (!row) throw new Error(`unknown blob: ${ref.id}`);
    const data = row.data;
    return Uint8Array.from(data);
  }

  #buildAppendTxn(): (p: AppendParams) => { seq: number; parent: string | null } {
    const head = this.#db.prepare<[string], { head: string | null; parent_seq: number }>(
      "SELECT c.head, COALESCE(i.seq, -1) AS parent_seq FROM conversations c LEFT JOIN items i ON i.id = c.head WHERE c.id = ?",
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
      const seq = Math.max(max?.m ?? -1, conv.parent_seq) + 1;
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

  // Atomic shallow-merge of the overrides layer. The read-merge-write runs in one IMMEDIATE txn, so
  // two concurrent patches of different keys can't lose a write the way a deferred SELECT-then-UPDATE
  // could. Kept in JS rather than SQLite's json_patch() — that's a *deep* RFC-7396 merge, which would
  // violate atomic replacement of top-level override keys such as `model`.
  #buildUpdateOverridesTxn(): (id: string, patch: ConversationOverrides) => void {
    const read = this.#db.prepare<[string], { overrides: string }>(
      "SELECT overrides FROM conversations WHERE id = ?",
    );
    const write = this.#db.prepare("UPDATE conversations SET overrides = ? WHERE id = ?");
    const txn = this.#db.transaction((id: string, patch: ConversationOverrides) => {
      const row = read.get(id);
      if (!row) throw new Error(`unknown conversation: ${id}`);
      const overrides = { ...(JSON.parse(row.overrides) as ConversationOverrides), ...patch };
      write.run(JSON.stringify(overrides), id);
    });
    return (id, patch) => txn.immediate(id, patch);
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

function rowToModelUsage(row: Database["model_usage"]): ModelUsage {
  return {
    id: row.id,
    conversationId: row.conversation_id as ConversationId,
    turnId: row.turn_id as TurnId,
    contextBuildId: row.context_build_id,
    provider: row.provider,
    model: row.model,
    ...(row.purpose === null ? {} : { purpose: row.purpose }),
    ...(row.request_duration_ms === null ? {} : { requestDurationMs: row.request_duration_ms }),
    usage: usageSchema.nullable().parse(JSON.parse(row.usage)) as Usage | null,
    cost: row.cost,
    ...(row.provider_usage === null
      ? {}
      : { providerUsage: jsonValueSchema.parse(JSON.parse(row.provider_usage)) }),
    ...(row.cost_incomplete ? { costIncomplete: true } : {}),
    ...(row.input_tokens_are_context === 0 ? { inputTokensAreContext: false } : {}),
    createdAt: row.created_at,
  };
}

function rowToRecord(row: Database["conversations"]): ConversationRecord {
  return {
    id: row.id as ConversationId,
    workspaceRoot: row.workspace_root,
    ...(row.original_workspace_root ? { originalWorkspaceRoot: row.original_workspace_root } : {}),
    title: row.title,
    overrides: JSON.parse(row.overrides) as ConversationOverrides,
    head: row.head as ItemId | null,
    ...(row.fork_origin === null
      ? {}
      : { fork: JSON.parse(row.fork_origin) as NonNullable<ConversationRecord["fork"]> }),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
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
