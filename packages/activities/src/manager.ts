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
  readonly #waiting = new Map<string, number>(); // overlapping foreground/explicit waits
  readonly #notices = new Map<string, (content: ContentBlock[]) => void>();
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
      this.#flushNotice(activity.id);
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

  /** Resolve only currently tracked handles, never durable family metadata or other owners. */
  resolve(reference: string): { id: string } | { error: string } {
    if (this.#byId.has(reference)) return { id: reference };
    const matches = [...this.#byId.values()].filter(
      (activity) => activity.reference === reference || activity.title === reference,
    );
    if (matches.length > 1)
      return { error: `ambiguous activity: ${reference}; use the canonical activity ID` };
    return matches[0] ? { id: matches[0].id } : { error: `unknown activity: ${reference}` };
  }

  /** Prefer an unambiguous readable handle; canonical IDs remain the collision fallback. */
  reference(id: string): string {
    const activity = this.#byId.get(id);
    if (!activity) throw new Error(`Cannot label unknown activity: ${id}`);
    for (const candidate of [activity.reference, activity.title]) {
      if (!candidate) continue;
      const resolved = this.resolve(candidate);
      if ("id" in resolved && resolved.id === id) return candidate;
    }
    return id;
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

  /**
   * Bounded wait; consume synchronously while the handle is protected, including
   * timeout-to-background notice registration. Never retain protection over an async consumer.
   */
  async wait<T>(
    id: string,
    timeoutMs: number,
    consume: (outcome: ActivityResult | "running", activity: Activity) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const activity = this.#byId.get(id);
    if (!activity) throw new Error(`Cannot wait for unknown activity: ${id}`);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<"running">((res) => {
      timer = setTimeout(() => res("running"), timeoutMs);
      timer.unref();
    });
    let onAbort: (() => void) | undefined;
    const cancelled = signal
      ? new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("activity wait aborted", { cause: signal.reason }));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;
    this.#waiting.set(id, (this.#waiting.get(id) ?? 0) + 1);
    try {
      const outcome = await Promise.race([
        activity.done,
        timeout,
        ...(cancelled ? [cancelled] : []),
      ]);
      signal?.throwIfAborted();
      if (outcome !== "running") {
        this.#surfaced.add(id);
        this.#notices.delete(id);
      }
      return consume(outcome, activity);
    } finally {
      clearTimeout(timer!);
      if (onAbort) signal!.removeEventListener("abort", onAbort);
      const remaining = this.#waiting.get(id)! - 1;
      if (remaining === 0) this.#waiting.delete(id);
      else this.#waiting.set(id, remaining);
      this.#flushNotice(id);
    }
  }

  /**
   * Arm a one-shot completion notice. Suppressed if the result was already surfaced inline, or if a
   * wait is in flight. Keep the callback until a successful wait consumes the result or the last
   * waiter leaves, so cancellation cannot discard the completion notice.
   */
  notifyOnExit(id: string, deliver: (content: ContentBlock[]) => void): void {
    if (!this.#byId.has(id) || this.#closed || this.#surfaced.has(id)) return;
    this.#notices.set(id, deliver);
    this.#flushNotice(id);
  }

  /** Stop accepting completion delivery, terminate live work, and await every requested stop. */
  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#notices.clear();
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
      // Settlement does not release a waiter or its pending completion delivery.
      if (this.#settled.has(id) && !this.#waiting.has(id) && !this.#notices.has(id)) {
        this.#byId.delete(id);
        this.#settled.delete(id);
        this.#surfaced.delete(id);
        this.#notices.delete(id);
        evicted.add(id);
      }
    }
    for (const [callId, id] of this.#byCall) if (evicted.has(id)) this.#byCall.delete(callId);
  }

  #flushNotice(id: string): void {
    const result = this.#settled.get(id);
    const deliver = this.#notices.get(id);
    if (!result || !deliver || this.#closed || this.#waiting.has(id) || this.#surfaced.has(id))
      return;
    this.#notices.delete(id);
    this.#surfaced.add(id);
    deliver(noticeContent(id, result, this.#byId.get(id), this.reference(id)));
  }
}

/** Labels use canonical IDs only when no readable reference can identify the handle. */
export function activityLabel(activity: Activity, reference: string): string {
  return activity.title === reference ? reference : `${activity.title} [${reference}]`;
}

/** The one-shot completion message body, using a resolved owner-local reference when available. */
export function noticeContent(
  id: string,
  result: ActivityResult,
  activity?: Activity,
  reference = id,
): ContentBlock[] {
  const label = activity && activity.title !== reference ? ` ${activity.title}` : "";
  return [
    { type: "text", text: `[activity ${reference}]${label} ${result.summary}` },
    ...result.view,
  ];
}

/** Narrows the opaque `ctx.service("activities")` to `ActivityManager`; throws if not wired. */
export function activitiesOf(ctx: ToolContext): ActivityManager {
  const service = ctx.service("activities");
  if (!service) {
    throw new Error("no activities service configured (add the activities plugin)");
  }
  return service as ActivityManager;
}
