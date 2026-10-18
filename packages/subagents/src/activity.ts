import {
  isKernelEvent,
  textOf,
  type ConversationId,
  type ConversationOverrides,
  type ConversationRunner,
  type ContentBlock,
  type HarnessEvent,
  type TurnStatus,
} from "@harness/protocol";
import type { Activity, ActivityResult } from "@harness/activities";
import type { SpawnMark } from "./registry.ts";

const PEEK_LINES = 40;
const LINE_CAP = 500;
const ARGS_PREVIEW_CHARS = 100;
const RESULT_PREVIEW_CHARS = 100;

/** `JSON.stringify` args truncated to ~100 chars; never throws (circular/BigInt-safe). */
function previewArgs(args: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(args) ?? "";
  } catch {
    raw = String(args);
  }
  return raw.length > ARGS_PREVIEW_CHARS ? `${raw.slice(0, ARGS_PREVIEW_CHARS)}…` : raw;
}

/** Single-line content preview truncated to ~100 chars (callers pass `textOf` output). */
function previewResult(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RESULT_PREVIEW_CHARS ? `${flat.slice(0, RESULT_PREVIEW_CHARS)}…` : flat;
}

export interface SubagentActivityInit {
  runner: ConversationRunner;
  /** The child conversation's id — also the activity id surfaced to `activity_*` and the UI. */
  childId: ConversationId;
  /** Display title supplied by the parent for this task. */
  title: string;
}

/**
 * The subagent `Activity` kind: surfaces a transcript tail via `peek`, resolves `done` with the
 * child's final assistant message; `kill` interrupts (idempotent).
 */
export class SubagentActivity implements Activity {
  readonly id: string;
  readonly kind = "subagent";
  readonly title: string;
  readonly done: Promise<ActivityResult>;
  /** The child conversation id (typed, vs the `string` the `Activity` interface exposes). */
  readonly childId: ConversationId;

  readonly #runner: ConversationRunner;
  readonly #lines: string[] = [];
  /** callId → index in #lines for the open `→ name args` line; lets the matching result rewrite it in place. */
  readonly #pendingCalls = new Map<string, number>();
  #finalText = "";
  #preview = "";
  #unsub?: () => void;
  #killed = false;
  #settled = false;
  #resolveDone!: (result: ActivityResult) => void;

  constructor(init: SubagentActivityInit) {
    this.id = init.childId;
    this.childId = init.childId;
    this.#runner = init.runner;
    this.title = init.title;
    this.done = new Promise<ActivityResult>((res) => (this.#resolveDone = res));
  }

  /** Wire the unsubscribe handle returned by `subscribe` (called right after subscribing). */
  arm(unsubscribe: () => void): void {
    this.#unsub = unsubscribe;
  }

  /** Feed a child event into the transcript tail and settlement tracker. */
  onEvent(event: HarnessEvent): void {
    if (!isKernelEvent(event)) return;
    switch (event.type) {
      case "text_delta":
        this.#preview = (this.#preview + event.text).slice(-LINE_CAP);
        break;
      case "item.appended": {
        const item = event.item;
        if (item.type === "message" && item.role === "assistant") {
          this.#preview = "";
          this.#finalText = textOf(item.content);
          this.#push(`assistant: ${this.#finalText}`);
        } else if (item.type === "tool_call") {
          const preview = previewArgs(item.args);
          const line = preview ? `→ ${item.name} ${preview}` : `→ ${item.name}`;
          this.#pendingCalls.set(item.callId, this.#lines.length);
          this.#push(line);
        } else if (item.type === "tool_result") {
          this.#resolveCall(item.callId, item.status, textOf(item.content));
        }
        break;
      }
      case "turn.status":
        if (event.status !== "running") this.#settle(event.status);
        break;
    }
  }

  peek(): ContentBlock[] {
    const tail = [
      ...this.#lines.slice(-PEEK_LINES),
      ...(this.#preview ? [`assistant: ${this.#preview}`] : []),
    ].join("\n");
    return [{ type: "text", text: tail || "(subagent starting…)" }];
  }

  kill(): void {
    if (this.#killed) return;
    this.#killed = true;
    void this.#runner.deliver(this.childId, "", "interrupt");
  }

  #push(line: string): void {
    this.#lines.push(line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…` : line);
  }

  /** Rewrite the matching call line in place; orphan results append a fallback line. */
  #resolveCall(callId: string, status: "ok" | "error", contentText: string): void {
    const suffix =
      status === "ok"
        ? " — ok"
        : (() => {
            const preview = previewResult(contentText);
            return preview ? ` — fail: ${preview}` : " — fail";
          })();
    const idx = this.#pendingCalls.get(callId);
    this.#pendingCalls.delete(callId);
    if (idx !== undefined && idx < this.#lines.length) {
      const updated = `${this.#lines[idx]}${suffix}`;
      this.#lines[idx] = updated.length > LINE_CAP ? `${updated.slice(0, LINE_CAP)}…` : updated;
    } else {
      this.#push(`→ ${callId}${suffix}`);
    }
  }

  #settle(status: TurnStatus): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#unsub?.();
    const ok = status === "completed";
    this.#resolveDone({
      status: ok ? "ok" : "error",
      summary: ok ? `subagent ${this.title} finished` : `subagent ${this.title} ${status}`,
      view: [{ type: "text", text: this.#finalText || "(no output)" }],
    });
  }
}

export interface SpawnInit {
  runner: ConversationRunner;
  parent: ConversationId;
  callId: string;
  agentName: string;
  name: string;
  slug: string;
  task: string;
  cwd?: string;
  overrides: ConversationOverrides;
}

/** Subscribes before the seeded `send` so the terminal `turn.status` can't be missed; returns the armed activity. */
export async function spawnSubagent(init: SpawnInit): Promise<SubagentActivity> {
  const child = await init.runner.createConversation(
    init.cwd !== undefined
      ? { cwd: init.cwd, overrides: init.overrides, parentId: init.parent }
      : { overrides: init.overrides, parentId: init.parent },
  );
  await init.runner.putPluginState(
    "subagents",
    child.id,
    "spawn",
    {
      parent: { conversationId: init.parent, callId: init.callId },
      agent: init.agentName,
      name: init.name,
      slug: init.slug,
    } satisfies SpawnMark,
    init.parent,
  );
  await init.runner.putPluginState("subagents", init.parent, `slug:${init.slug}`, child.id);
  const activity = new SubagentActivity({
    runner: init.runner,
    childId: child.id,
    title: init.name,
  });
  activity.arm(init.runner.subscribe(child.id, (event) => activity.onEvent(event)));
  await init.runner.deliver(child.id, init.task, "send");
  return activity;
}
