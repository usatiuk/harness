import type {
  ContentBlock,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "@harness/protocol";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

/** Demo-only pause so a turn lasts long enough to steer/interrupt by hand. */
const DEMO_LATENCY_MS = 400;

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** Resolves after `ms`, or immediately when the signal aborts. Demo-only. */
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Request-aware stand-in until a real provider lands. Each turn it calls the echo
 * tool with the user's text, then replies — so every typed message drives a full
 * tool-shaped turn. Demo-only latency between events makes the turn long enough to
 * steer/interrupt by hand; it honors the abort signal so Esc cancels mid-stream.
 */
export class DemoProvider implements ModelProvider {
  readonly provider = "demo";
  #calls = 0;

  capabilities() {
    return { contentTypes: ["text"], toolCalling: true };
  }

  validateConfig(): void {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const last = request.items.at(-1)?.item;

    if (last?.type === "tool_result") {
      const text = "Done — echoed your message via the echo tool.";
      await delay(DEMO_LATENCY_MS, signal);
      if (signal.aborted) return;
      yield { type: "text_delta", text };
      yield { type: "completed", content: [{ type: "text", text }], usage: ZERO_USAGE };
      return;
    }

    const lastUser = [...request.items]
      .reverse()
      .map((i) => i.item)
      .find((i) => i.type === "message" && i.role === "user");
    const youSaid = lastUser && lastUser.type === "message" ? textOf(lastUser.content) : "";

    await delay(DEMO_LATENCY_MS, signal);
    if (signal.aborted) return;
    yield {
      type: "tool_call",
      callId: `call-${++this.#calls}`,
      name: "echo",
      args: { youSaid },
    };
    yield { type: "completed", content: [], usage: ZERO_USAGE };
  }
}
