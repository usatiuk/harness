import type { ContentBlock, ConversationId, PluginEvent, ToolContext } from "@harness/protocol";
import type { Activity, ActivityResult } from "./activity.ts";

export { isActivityEvent, type ActivityEvent } from "./events.ts";

/** Pushes a plugin event onto the conversation's stream (the engine's `ctx.emit`). */
type Emit = (event: PluginEvent) => void;

/** Cap on tracked activities per conversation; settled ones are GC'd to make room. */
const MAX_LIVE = 50;

/**
 * Per-conversation tracker. Indexes activities by id and by originating `callId`; a result surfaces
 * at most once across inline-settle, `activity_wait`, and the proactive notice.
 */
export class ActivityManager {
  readonly #byId = new Map<string, Activity>();
  readonly #byCall = new Map<string, string>(); // callId -> activityId, claimed once
  readonly #settled = new Map<string, ActivityResult>();
  readonly #surfaced = new Set<string>(); // result already shown once
  readonly #waiting = new Set<string>(); // a foreground/explicit wait is in flight
  #closed = false;

  constructor(private readonly conversationId: ConversationId) {}

  track(activity: Activity, { callId, emit }: { callId: string; emit: Emit }): void {
    this.#gc();
    if (this.#byId.has(activity.id))
      throw new Error(`activity '${activity.id}' is already tracked`);
    if (this.#byCall.has(callId)) throw new Error(`activity call '${callId}' is already tracked`);
    this.#byId.set(activity.id, activity);
    this.#byCall.set(callId, activity.id);
    emit({
      type: "activity.started",
      conversationId: this.conversationId,
      id: activity.id,
      kind: activity.kind,
      title: activity.title,
    });
    void activity.done.then((result) => {
      this.#settled.set(activity.id, result);
      emit({
        type: "activity.exited",
        conversationId: this.conversationId,
        id: activity.id,
        status: result.status,
        summary: result.summary,
      });
    });
  }

  /** The activity THIS dispatch started, consumed once. */
  claim(callId: string): Activity | undefined {
    const id = this.#byCall.get(callId);
    if (id === undefined) return undefined;
    this.#byCall.delete(callId);
    return this.#byId.get(id);
  }

  get(id: string): Activity | undefined {
    return this.#byId.get(id);
  }

  list(): Activity[] {
    return [...this.#byId.values()];
  }

  /** How many tracked activities haven't settled yet. */
  runningCount(): number {
    let n = 0;
    for (const id of this.#byId.keys()) if (!this.#settled.has(id)) n++;
    return n;
  }

  /** The settled result, or `undefined` while still running. */
  resultOf(id: string): ActivityResult | undefined {
    return this.#settled.get(id);
  }

  /** Request termination only while an activity is live; settled handles must never be reused. */
  kill(id: string): "requested" | "settled" | "unknown" {
    const activity = this.#byId.get(id);
    if (!activity) return "unknown";
    if (this.#settled.has(id)) return "settled";
    activity.kill();
    return "requested";
  }

  /** Bounded wait over `activity.done`; marks the result surfaced on settle. */
  async wait(id: string, timeoutMs: number): Promise<ActivityResult | "running"> {
    const activity = this.#byId.get(id);
    if (!activity) return "running";
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<"running">((res) => {
      timer = setTimeout(() => res("running"), timeoutMs);
      timer.unref();
    });
    this.#waiting.add(id);
    try {
      const outcome = await Promise.race([activity.done, timeout]);
      if (outcome !== "running") this.#surfaced.add(id);
      return outcome;
    } finally {
      clearTimeout(timer!);
      this.#waiting.delete(id);
    }
  }

  /**
   * Arm a one-shot completion notice. Suppressed if the result was already surfaced inline, or if a
   * wait is in flight at exit time (that wait will deliver it) — so a completion never doubles.
   */
  notifyOnExit(id: string, deliver: (content: ContentBlock[]) => void): void {
    const activity = this.#byId.get(id);
    if (!activity) return;
    void activity.done.then((result) => {
      if (this.#closed || this.#surfaced.has(id) || this.#waiting.has(id)) return;
      this.#surfaced.add(id);
      deliver(noticeContent(id, result));
    });
  }

  /** Stop accepting completion delivery, terminate live work, and await every requested stop. */
  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const live = [...this.#byId.entries()]
      .filter(([id]) => !this.#settled.has(id))
      .map(([, activity]) => activity);
    for (const activity of live) activity.kill();
    await Promise.all(live.map((activity) => activity.done));
  }

  #gc(): void {
    if (this.#byId.size < MAX_LIVE) return;
    const evicted = new Set<string>();
    for (const [id] of this.#byId) {
      if (this.#byId.size < MAX_LIVE) break;
      if (this.#settled.has(id)) {
        this.#byId.delete(id);
        this.#settled.delete(id);
        this.#surfaced.delete(id);
        evicted.add(id);
      }
    }
    for (const [callId, id] of this.#byCall) if (evicted.has(id)) this.#byCall.delete(callId);
  }
}

/** The one-shot completion message body: a self-describing line plus the bounded output view. */
export function noticeContent(id: string, result: ActivityResult): ContentBlock[] {
  return [{ type: "text", text: `[activity ${id}] ${result.summary}` }, ...result.view];
}

/** Narrows the opaque `ctx.service("activities")` to `ActivityManager`; throws if not wired. */
export function activitiesOf(ctx: ToolContext): ActivityManager {
  const service = ctx.service("activities");
  if (!service) {
    throw new Error("no activities service configured (add the activities plugin)");
  }
  return service as ActivityManager;
}
