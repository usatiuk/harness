import {
  isKernelEvent,
  textOf,
  type ConversationId,
  type ConversationRunner,
  type ContentBlock,
  type HarnessEvent,
  type TurnId,
  type TurnStatus,
} from "@harness/protocol";
import type { Activity, ActivityResult } from "@harness/activities";

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

interface SubagentActivityInit {
  runner: ConversationRunner;
  childId: ConversationId;
  turnId: TurnId;
  /** Display title supplied by the parent for this task. */
  title: string;
  reference?: string;
}

/** One child turn. Peek shows a bounded tail; completion carries the final answer. */
export class SubagentActivity implements Activity {
  readonly id: TurnId;
  readonly kind = "subagent";
  readonly title: string;
  readonly reference?: string;
  readonly done: Promise<ActivityResult>;
  readonly #childId: ConversationId;

  readonly #runner: ConversationRunner;
  readonly #lines: { text: string; callId?: string }[] = [];
  #preview = "";
  #answer: ContentBlock[] = [];
  readonly #unsubscribe: () => void;
  #resolveDone!: (result: ActivityResult) => void;

  constructor(init: SubagentActivityInit) {
    this.id = init.turnId;
    this.#childId = init.childId;
    this.#runner = init.runner;
    this.title = init.title;
    if (init.reference !== undefined) this.reference = init.reference;
    this.done = new Promise<ActivityResult>((res) => (this.#resolveDone = res));
    this.#unsubscribe = init.runner.subscribe(init.childId, (event) => this.onEvent(event));
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
          this.#answer = item.content;
          this.#push(`assistant: ${textOf(item.content)}`);
        } else if (item.type === "tool_call") {
          const preview = previewArgs(item.args);
          const line = preview ? `→ ${item.name} ${preview}` : `→ ${item.name}`;
          this.#push(line, item.callId);
        } else if (item.type === "tool_result") {
          this.#resolveCall(item.callId, item.status, textOf(item.content));
        }
        break;
      }
      case "turn.status":
        if (event.turnId === this.id && event.status !== "running") this.#settle(event.status);
        break;
    }
  }

  peek(): ContentBlock[] {
    const tail = [
      ...this.#lines.map((line) => line.text),
      ...(this.#preview ? [`assistant: ${this.#preview}`] : []),
    ].join("\n");
    return [{ type: "text", text: tail || "(subagent starting…)" }];
  }

  kill(): void {
    this.#runner.interruptTurn(this.#childId, this.id);
  }

  #push(line: string, callId?: string): void {
    if (this.#lines.length === PEEK_LINES) this.#lines.shift();
    this.#lines.push({ text: clipLine(line), ...(callId === undefined ? {} : { callId }) });
  }

  /** Rewrite the matching call line in place; orphan results append a fallback line. */
  #resolveCall(callId: string, status: "ok" | "error", contentText: string): void {
    const preview = status === "error" && previewResult(contentText);
    const suffix = status === "ok" ? " — ok" : preview ? ` — fail: ${preview}` : " — fail";
    const line = this.#lines.find((entry) => entry.callId === callId);
    if (line) {
      line.text = clipLine(line.text + suffix);
      delete line.callId;
    } else {
      this.#push(`→ ${callId}${suffix}`);
    }
  }

  #settle(status: TurnStatus): void {
    this.#unsubscribe();
    const ok = status === "completed";
    this.#resolveDone({
      status: ok ? "ok" : "error",
      summary: ok ? `subagent ${this.title} finished` : `subagent ${this.title} ${status}`,
      view: this.#answer,
    });
  }
}

function clipLine(line: string): string {
  return line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…` : line;
}
