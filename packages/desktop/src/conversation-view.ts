import { init, type State } from "@harness/client-features/transcript-reducer";
import type { SubagentIdentity } from "@harness/client-features";
import type { ClientQuestionRequest } from "@harness/questions/client";
import type { ClientApproval } from "@harness/approval/client";
import type { Conversation, Item } from "@harness/protocol";
import { DesktopTranscript } from "./transcript.ts";

/** Cached presentation values; live record mutations never change a published snapshot. */
export interface ConversationSnapshot {
  subagent: SubagentIdentity | null;
  subagentRevision: number;
  conversation: Conversation;
  state: State;
  transcript: Pick<DesktopTranscript, "rows">;
  approvals: ReadonlyMap<string, ClientApproval>;
  questions: ReadonlyMap<string, ClientQuestionRequest>;
  anchor: string | null;
  cursor: string | null;
}

/** One attachment owns live state, its transcript projection and publication timer. */
export class ConversationView {
  subagentRevision = 0;
  state = init([]);
  readonly transcript = new DesktopTranscript();
  approvals = new Map<string, ClientApproval>();
  questions = new Map<string, ClientQuestionRequest>();
  items: Item[] = [];
  anchor: string | null = null;
  cursor: string | null = null;
  private readonly listeners = new Set<() => void>();
  private published: ConversationSnapshot | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPublishedAt = -Infinity;
  private disposed = false;

  constructor(
    public conversation: Conversation,
    public subagent: SubagentIdentity | null = null,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): ConversationSnapshot => (this.published ??= this.capture());

  publish(streaming = false): void {
    if (this.disposed) return; // An earlier-history request may finish after detach.
    const remaining = 100 - (performance.now() - this.lastPublishedAt);
    if (streaming && remaining > 0) {
      this.timer ??= setTimeout(() => this.publish(), Math.ceil(remaining));
      return;
    }
    this.cancelTimer();
    const next = this.capture();
    const previous = this.published;
    if (
      previous &&
      next.state === previous.state &&
      next.conversation === previous.conversation &&
      next.subagent === previous.subagent &&
      next.subagentRevision === previous.subagentRevision &&
      next.approvals === previous.approvals &&
      next.questions === previous.questions &&
      next.anchor === previous.anchor &&
      next.cursor === previous.cursor &&
      next.transcript.rows === previous.transcript.rows
    )
      return;
    this.published = next;
    this.lastPublishedAt = performance.now();
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
  }

  private cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private capture(): ConversationSnapshot {
    this.transcript.update(
      this.state.cells,
      this.state.turn.status === "running" ? this.state.turn.id : undefined,
    );
    return {
      conversation: this.conversation,
      subagent: this.subagent,
      subagentRevision: this.subagentRevision,
      state: this.state,
      transcript: { rows: this.transcript.rows },
      approvals: this.approvals,
      questions: this.questions,
      anchor: this.anchor,
      cursor: this.cursor,
    };
  }
}
