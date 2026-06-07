import type { ModelProvider, ModelStreamEvent, ProviderPayloadDraft } from "@harness/protocol";
import { awaitReleaseOrAbort } from "./gate.ts";

/** Events yielded for one model step; must end with a `completed` event. */
export type FakeStep = ModelStreamEvent[];

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

/** One part of an interleaved step: a text segment, or a tool call. */
export type InterleavedPart = string | { callId: string; name: string; args: unknown };

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
 * A step that emits its parts in order — e.g. `text → call → text → call` — so a
 * test can assert the engine preserves emission order (text/calls interleaved).
 */
export function interleavedStep(parts: InterleavedPart[]): FakeStep {
  const events: ModelStreamEvent[] = parts.map((part) =>
    typeof part === "string"
      ? { type: "text_delta", text: part }
      : { type: "tool_call", callId: part.callId, name: part.name, args: part.args },
  );
  events.push({ type: "completed", content: [], usage: ZERO_USAGE });
  return events;
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

/**
 * Streams its text as one delta, then blocks before `completed` until `release()`
 * or abort — so a test can interrupt mid-stream. `started` resolves once the text
 * has streamed and the provider is blocking.
 */
export class GateProvider implements ModelProvider {
  readonly provider = "fake";
  readonly started: Promise<void>;
  readonly #text: string;
  #markStarted!: () => void;
  #open!: () => void;
  readonly #gate: Promise<void>;

  constructor(text: string) {
    this.#text = text;
    this.started = new Promise<void>((resolve) => (this.#markStarted = resolve));
    this.#gate = new Promise<void>((resolve) => (this.#open = resolve));
  }

  /** Unblocks the stream so it emits `completed`. */
  release(): void {
    this.#open();
  }

  capabilities() {
    return { contentTypes: ["text"], toolCalling: true };
  }

  validateConfig(): void {}

  async *stream(_request: unknown, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    if (this.#text) yield { type: "text_delta", text: this.#text };
    this.#markStarted();
    await awaitReleaseOrAbort(this.#gate, signal);
    if (signal.aborted) return;
    yield { type: "completed", content: [{ type: "text", text: this.#text }], usage: ZERO_USAGE };
  }
}
