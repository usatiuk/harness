import type { ModelProvider, ModelStreamEvent, ProviderPayloadDraft } from "@harness/protocol";

/** Events yielded for one model step; must end with a `completed` event. */
export type FakeStep = ModelStreamEvent[];

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

/** A step that streams `text` and completes with it as the final message. */
export function textStep(text: string, payload?: ProviderPayloadDraft): FakeStep {
  return [
    { type: "text_delta", text },
    {
      type: "completed",
      content: [{ type: "text", text }],
      usage: ZERO_USAGE,
      ...(payload ? { payload } : {}),
    },
  ];
}

/** A step that requests a single tool call and completes with no message. */
export function toolStep(callId: string, name: string, args: unknown): FakeStep {
  return [
    { type: "tool_call", callId, name, args },
    { type: "completed", content: [], usage: ZERO_USAGE },
  ];
}

/**
 * Scripts the model: each `stream()` call replays the next step in order. Lets
 * tests drive a full tool-shaped turn deterministically.
 */
export class FakeProvider implements ModelProvider {
  readonly provider = "fake";
  readonly #steps: FakeStep[];
  #cursor = 0;

  constructor(steps: FakeStep[]) {
    this.#steps = steps;
  }

  capabilities() {
    return { contentTypes: ["text"], toolCalling: true };
  }

  validateConfig(): void {}

  async *stream(): AsyncIterable<ModelStreamEvent> {
    const step = this.#steps[this.#cursor++];
    if (!step) {
      throw new Error("FakeProvider: no scripted step remaining");
    }
    for (const event of step) {
      yield event;
    }
  }
}
