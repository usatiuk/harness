import { mkdir, readdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readGlobalSettings, updateGlobalPluginConfig } from "@harness/config";
import type { Store, ConversationId, ItemId, Item } from "@harness/protocol";
import type { HarnessRpcSession } from "@harness/service";
import {
  feedbackSettingsSchema,
  feedbackStatusRequest,
  feedbackConfigureRequest,
  feedbackVoteRequest,
  feedbackRetryRequest,
} from "./client.ts";

const execute = promisify(execFile);
const MAX_BYTES = 32 * 1024 * 1024;
export const feedbackPlugin = {
  id: "feedback",
  configScope: "global" as const,
  configSchema: feedbackSettingsSchema,
  create: () => ({ id: "feedback" }),
};
interface Pending {
  endpoint: string;
  tokenEnv: string;
  body: unknown;
  status: "queued" | "delivered";
  attempts: number;
  error?: string;
}

/** Durable local outbox, separate from the canonical immutable execution log. */
export class FeedbackRuntime {
  private readonly directory: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  constructor(
    private readonly home: string,
    private readonly store: Store,
  ) {
    this.directory = join(home, "feedback");
  }
  async start(): Promise<void> {
    await mkdir(join(this.directory, "delivered"), { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => {
      void this.retry().catch(() => {
        /* RPC exposes queue status; durable entries survive. */
      });
    }, 15000);
    this.timer.unref();
    void this.retry().catch(() => {});
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await this.tail;
  }
  private async config() {
    return feedbackSettingsSchema.parse(
      (await readGlobalSettings(this.home)).plugins?.["feedback"] ?? {},
    );
  }
  private async paths() {
    return (await readdir(this.directory)).filter((name) => /^[a-f\d-]{36}\.json$/u.test(name));
  }
  private async save(id: string, value: Pending) {
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    if (value.status === "delivered") {
      // Keep only a small idempotency receipt; originals remain in Harness/MAI.
      const body = value.body as {
        id: string;
        selected_item_id: string;
        conversation_id: string;
        vote: string;
        comment: string;
      };
      await writeFile(
        temporary,
        JSON.stringify({
          ...value,
          body: {
            id: body.id,
            selected_item_id: body.selected_item_id,
            conversation_id: body.conversation_id,
            vote: body.vote,
            comment: body.comment,
          },
        }),
        { mode: 0o600 },
      );
      await rename(temporary, join(this.directory, "delivered", `${id}.json`));
      await rm(join(this.directory, `${id}.json`), { force: true });
    } else await rename(temporary, join(this.directory, `${id}.json`));
  }
  async status() {
    const config = await this.config();
    let pending = 0,
      failed = 0;
    for (const path of await this.paths()) {
      const entry = JSON.parse(await readFile(join(this.directory, path), "utf8")) as Pending;
      if (entry.status === "queued") {
        pending++;
        if (entry.error) failed++;
      }
    }
    return {
      ...config,
      configured: Boolean(config.endpoint && process.env[config.tokenEnv]),
      pending,
      failed,
    };
  }
  retry(): Promise<void> {
    const run = this.tail.then(async () => {
      const config = await this.config();
      if (!config.enabled || this.closing) return;
      for (const path of await this.paths()) {
        if (this.closing) return;
        const entry = JSON.parse(await readFile(join(this.directory, path), "utf8")) as Pending;
        if (entry.status === "delivered") continue;
        // A settings edit cannot silently reroute previously captured private evidence.
        if (entry.endpoint !== config.endpoint || entry.tokenEnv !== config.tokenEnv) continue;
        const token = process.env[entry.tokenEnv];
        if (!token) continue;
        entry.attempts++;
        try {
          const response = await fetch(`${entry.endpoint.replace(/\/$/u, "")}/api/cases`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(entry.body),
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result = (await response.json()) as { id?: string };
          if (result.id !== path.slice(0, -5)) throw new Error("Unexpected case acknowledgement");
          entry.status = "delivered";
          delete entry.error;
        } catch (error) {
          entry.error =
            error instanceof Error && /^HTTP \d+$/u.test(error.message)
              ? error.message
              : "Delivery failed; retained locally";
        }
        await this.save(path.slice(0, -5), entry);
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }
  register(session: HarnessRpcSession): void {
    session.onRequest(feedbackStatusRequest, () => this.status());
    session.onRequest(feedbackConfigureRequest, async (config) => {
      await updateGlobalPluginConfig(this.home, "feedback", config, { replace: true });
      return null;
    });
    session.onRequest(feedbackRetryRequest, async () => {
      await this.retry();
      return null;
    });
    session.onRequest(feedbackVoteRequest, async (params) => {
      const config = await this.config();
      if (!config.enabled || !process.env[config.tokenEnv])
        throw new Error("Feedback is disabled or not configured");
      const conversationId = params.conversationId as ConversationId;
      return session.runAttached(conversationId, async () => {
        const filename = join(this.directory, `${params.id}.json`);
        try {
          const saved = await readFile(
            join(this.directory, "delivered", `${params.id}.json`),
            "utf8",
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return readFile(filename, "utf8");
          });
          const old = JSON.parse(saved) as Pending;
          const body = old.body as {
            selected_item_id: string;
            vote: string;
            comment: string;
            conversation_id: string;
          };
          if (
            body.selected_item_id !== params.itemId ||
            body.vote !== params.vote ||
            body.comment !== params.comment ||
            body.conversation_id !== params.conversationId
          )
            throw new Error("Feedback identity reused with different intent");
          return {
            id: params.id,
            status: old.status,
            url: `${old.endpoint}/#/feedback/${encodeURIComponent(params.id)}`,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const conversation = await this.store.getConversation(conversationId);
        if (!conversation) throw new Error("Unknown conversation");
        const selected = await this.store.getItem(params.itemId as ItemId);
        if (
          !selected ||
          !["message", "reasoning", "tool_call"].includes(selected.type) ||
          (selected.type === "message" && selected.role !== "assistant")
        )
          throw new Error("Feedback requires assistant behavior");
        const transcript: Item[] = [];
        let head = conversation.head;
        while (head) {
          const page = await this.store.listItemAncestors(head, 128);
          transcript.push(...page);
          head = page.at(-1)?.parent ?? null;
          if (Buffer.byteLength(JSON.stringify(transcript)) > MAX_BYTES)
            throw new Error("Evidence exceeds 32 MiB; no silent truncation was performed");
        }
        transcript.reverse();
        if (!transcript.some((item) => item.id === selected.id))
          throw new Error("Selected item is not on this conversation branch");
        let decision: Item = selected;
        if (decision.type === "tool_call" && decision.parentCallId) {
          const nested = decision;
          decision =
            transcript.find(
              (item) =>
                item.type === "tool_call" &&
                item.callId === nested.parentCallId &&
                item.turnId === nested.turnId,
            ) ?? decision;
        }
        const link = (await this.store.getPluginState(
          "model-evidence",
          decision.conversationId,
          `item:${decision.id}`,
        )) as { attemptId?: string } | undefined;
        const trace = link?.attemptId
          ? ((await this.store.getPluginState(
              "model-evidence",
              decision.conversationId,
              link.attemptId,
            )) as { request?: unknown; nativeRequest?: unknown; limitation?: string })
          : undefined;
        let repository: unknown = { status: "not_available" };
        if (conversation.workspaceRoot) {
          try {
            const options = {
              cwd: conversation.workspaceRoot,
              timeout: 3000,
              maxBuffer: 2 * 1024 * 1024,
            };
            const [revision, status, patch] = await Promise.all([
              execute("git", ["rev-parse", "HEAD"], options),
              execute("git", ["status", "--porcelain=v1"], options),
              execute("git", ["diff", "HEAD", "--no-ext-diff", "--no-textconv"], options),
            ]);
            repository = {
              revision: revision.stdout.trim(),
              status: status.stdout,
              patch: patch.stdout,
              untracked_contents: "not captured",
              replay: "not guaranteed",
            };
          } catch {
            repository = { status: "capture_unavailable_or_over_limit" };
          }
        }
        const payloads = await this.store.getProviderPayloads(
          transcript.filter((item) => item.type === "reasoning").map((item) => item.id),
        );
        const reasoningKinds = new Map(
          payloads.map((payload) => [
            payload.itemId,
            payload.type === "chat_reasoning" ? "exposed_text" : "summary_or_provider_artifact",
          ]),
        );
        const annotatedTranscript = transcript.map((item) =>
          item.type === "reasoning"
            ? { ...item, reasoningKind: reasoningKinds.get(item.id) ?? "unknown" }
            : item,
        );
        const originalOutputs = [];
        if (link?.attemptId)
          for (const item of annotatedTranscript) {
            const source = (await this.store.getPluginState(
              "model-evidence",
              item.conversationId,
              `item:${item.id}`,
            )) as { attemptId?: string } | undefined;
            if (source?.attemptId === link.attemptId) originalOutputs.push(item);
          }
        const effective = trace?.request as
          { items?: { item: unknown; payload?: unknown }[] } | undefined;
        const exportedRequest = effective
          ? { ...effective, items: effective.items?.map(({ item }) => ({ item })) }
          : null;
        // Opaque provider-native reasoning stays in Harness. Chat request bodies
        // contain explicit text and function calls; other native formats are not SFT inputs here.
        const native = trace?.nativeRequest as { messages?: unknown[] } | undefined;
        const body = {
          version: 1,
          id: params.id,
          vote: params.vote,
          comment: params.comment,
          conversation_id: params.conversationId,
          selected_item_id: selected.id,
          evidence: {
            conversation,
            selected,
            decision,
            invocation_id: link?.attemptId ?? null,
            effective_request: exportedRequest,
            native_request: native?.messages ? native : null,
            transcript: annotatedTranscript,
            original_outputs: originalOutputs,
            repository,
            limitations: [
              trace?.limitation ?? "Historical invocation input unavailable",
              "Reasoning content is provider-exposed text or summary; opaque artifacts are not internal reasoning",
              "No environment variables, credential headers or opaque provider payloads exported; non-chat native body remains in Harness",
            ],
          },
        };
        if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES)
          throw new Error("Evidence exceeds 32 MiB; vote was not saved");
        await this.save(params.id, {
          endpoint: config.endpoint,
          tokenEnv: config.tokenEnv,
          body,
          status: "queued",
          attempts: 0,
        });
        void this.retry().catch(() => {});
        return {
          id: params.id,
          status: "queued" as const,
          url: `${config.endpoint}/#/feedback/${encodeURIComponent(params.id)}`,
        };
      });
    });
  }
}
