import type {
  ModelInfo,
  ModelProvider,
  ModelStreamEvent,
  ProviderPayloadDraft,
  Usage,
} from "@harness/protocol";
import { awaitReleaseOrAbort } from "./gate.ts";

/** Events yielded for one model step; must end with a `completed` event. */
export type FakeStep = ModelStreamEvent[];

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 };

/** One part of an interleaved step: a text segment, a tool call, or a reasoning item. */
export type InterleavedPart =
  | string
  | { callId: string; name: string; args: unknown; payload?: ProviderPayloadDraft }
  | { reasoning: string; payload?: ProviderPayloadDraft };

/** A step that streams `text` and completes with it as the final message. */
export function textStep(
  text: string,
  payload?: ProviderPayloadDraft,
  usage: Usage = ZERO_USAGE,
): FakeStep {
  return [
    { type: "text_delta", text },
    {
      type: "completed",
      content: [{ type: "text", text }],
      usage,
      ...(payload ? { payload } : {}),
    },
  ];
}

/** A step that requests a single tool call and completes with no message. */
export function toolStep(
  callId: string,
  name: string,
  args: unknown,
  usage: Usage = ZERO_USAGE,
): FakeStep {
  return [
    { type: "tool_call", callId, name, args },
    { type: "completed", content: [], usage },
  ];
}

/** A reasoning summary streamed as a delta then its complete item, like a real provider. */
function reasoningEvents(summary: string, payload?: ProviderPayloadDraft): ModelStreamEvent[] {
  return [
    { type: "reasoning_delta", text: summary },
    {
      type: "reasoning",
      content: [{ type: "text", text: summary }],
      ...(payload ? { payload } : {}),
    },
  ];
}

/**
 * A step that emits its parts in order — e.g. `reasoning → text → call` — so a test
 * can assert the engine preserves emission order.
 */
export function interleavedStep(parts: InterleavedPart[]): FakeStep {
  const events: ModelStreamEvent[] = parts.flatMap((part): ModelStreamEvent[] => {
    if (typeof part === "string") return [{ type: "text_delta", text: part }];
    if ("reasoning" in part) return reasoningEvents(part.reasoning, part.payload);
    return [
      {
        type: "tool_call",
        callId: part.callId,
        name: part.name,
        args: part.args,
        ...(part.payload ? { payload: part.payload } : {}),
      },
    ];
  });
  events.push({ type: "completed", content: [], usage: ZERO_USAGE });
  return events;
}

/** A step that streams a reasoning summary (+ optional opaque payload) then completes. */
export function reasoningStep(
  summary: string,
  opts: { payload?: ProviderPayloadDraft } = {},
): FakeStep {
  return [
    ...reasoningEvents(summary, opts.payload),
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
    return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" as const };
  }

  validateConfig(): void {}

  listModels(): ModelInfo[] {
    return [];
  }

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
    return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" as const };
  }

  validateConfig(): void {}

  listModels(): ModelInfo[] {
    return [];
  }

  async *stream(_request: unknown, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    if (this.#text) yield { type: "text_delta", text: this.#text };
    this.#markStarted();
    await awaitReleaseOrAbort(this.#gate, signal);
    if (signal.aborted) return;
    yield { type: "completed", content: [{ type: "text", text: this.#text }], usage: ZERO_USAGE };
  }
}
