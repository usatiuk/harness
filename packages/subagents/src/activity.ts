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

export interface SubagentActivityInit {
  runner: ConversationRunner;
  /** The child conversation's id — also the activity id surfaced to `activity_*` and the UI. */
  childId: ConversationId;
  /** Display title — the agent name. */
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
  #finalText = "";
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
      case "message": {
        const item = event.item;
        if (item.type === "message" && item.role === "assistant") {
          this.#finalText = textOf(item.content);
          this.#push(`assistant: ${this.#finalText}`);
        }
        break;
      }
      case "tool_call.started":
        this.#push(`→ ${event.name}`);
        break;
      case "tool_call.completed":
        this.#push(`  ${event.status}`);
        break;
      case "turn.status":
        if (event.status !== "running") this.#settle(event.status);
        break;
    }
  }

  peek(): ContentBlock[] {
    const tail = this.#lines.slice(-PEEK_LINES).join("\n");
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
  task: string;
  cwd?: string;
  overrides: ConversationOverrides;
}

/** Subscribes before the seeded `send` so the terminal `turn.status` can't be missed; returns the armed activity. */
export async function spawnSubagent(init: SpawnInit): Promise<SubagentActivity> {
  const child = await init.runner.createConversation(
    init.cwd !== undefined
      ? { cwd: init.cwd, overrides: init.overrides }
      : { overrides: init.overrides },
  );
  await init.runner.putPluginState("subagents", child.id, "spawn", {
    parent: { conversationId: init.parent, callId: init.callId },
    agent: init.agentName,
  } satisfies SpawnMark);
  const activity = new SubagentActivity({
    runner: init.runner,
    childId: child.id,
    title: init.agentName,
  });
  activity.arm(init.runner.subscribe(child.id, (event) => activity.onEvent(event)));
  await init.runner.deliver(child.id, init.task, "send");
  return activity;
}
