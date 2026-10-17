import { reduce, type Cell } from "@harness/client-features/transcript-reducer";
import type { TurnId } from "@harness/protocol";
// Reuse the existing fixture edge; routes/renderers stay production code.
import { view, session } from "./composer-fixture.ts";

const attachment = view;
Object.assign(session.plugins, {
  runningActivities: () =>
    attachment.state.activities.filter((activity) => activity.status === undefined).length,
});
const counts = () =>
  ((window as unknown as { renderCounts: Record<string, number> }).renderCounts ??= {});
const project = attachment.transcript.update.bind(attachment.transcript);
attachment.transcript.update = (...args) => {
  counts().projection = (counts().projection ?? 0) + 1;
  project(...args);
};

declare global {
  interface Window {
    performanceFixture: {
      seed(): void;
      burst(count: number): void;
      finish(): void;
      startActivityWithoutNotification(): void;
      counts(): Record<string, number>;
      reset(): void;
    };
  }
}
window.performanceFixture = {
  seed() {
    const history: Cell[] = Array.from({ length: 1000 }, (_, index) => ({
      kind: "assistant",
      id: `old-${index}`,
      turnId: `old-turn-${index}`,
      text: `History ${index}`,
      streaming: false,
    }));
    attachment.state = {
      ...attachment.state,
      cells: [
        ...history,
        { kind: "user", id: "prompt", turnId: "old-turn", text: "Prompt", createdAt: 0 },
        {
          kind: "assistant",
          id: "stable",
          turnId: "old-turn",
          text: "Stable visible message",
          streaming: false,
        },
        {
          kind: "tool",
          callId: "write",
          turnId: "turn",
          name: "write",
          args: { path: "large.txt", content: "unchanged\n".repeat(5000) },
          startedAt: 0,
          status: "ok",
          output: "done",
        },
        { kind: "assistant", turnId: "turn", text: "Live", streaming: true },
      ],
    };
    attachment.publish();
  },
  burst(count) {
    for (let index = 0; index < count; index++) {
      attachment.state = reduce(
        attachment.state,
        {
          type: "text_delta",
          conversationId: attachment.conversation.id,
          turnId: "turn" as TurnId,
          text: "x",
        },
        Date.now(),
      );
      attachment.publish(true);
    }
  },
  finish() {
    attachment.state = { ...attachment.state, turn: { id: "turn", status: "completed" } };
    attachment.publish();
  },
  startActivityWithoutNotification() {
    attachment.state = {
      ...attachment.state,
      activities: [
        {
          conversationId: attachment.conversation.id,
          id: "late-activity",
          kind: "command",
          title: "Still running",
        },
      ],
    };
  },
  counts: () => ({ ...counts() }),
  reset() {
    for (const key of Object.keys(counts())) counts()[key] = 0;
  },
};
