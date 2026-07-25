import {
  textOf,
  zeroUsage,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@harness/protocol";

const ZERO_USAGE = zeroUsage();

/** Demo-only pause so a turn lasts long enough to steer/interrupt by hand. */
const DEMO_LATENCY_MS = 400;

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

const bashQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const powershellQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Demo-only provider. Each turn calls the offered command tool to echo the user's text, then replies —
 * exercising the full tool + approval pipeline (command scope is unknown, so it
 * prompts for approval). Artificial latency keeps turns long enough to steer/interrupt
 * by hand, and it honors the abort signal.
 */
export class DemoProvider implements ModelProvider {
  readonly provider = "demo";
  #calls = 0;

  capabilities() {
    return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" as const };
  }

  validateConfig(): void {}

  listModels(): ModelInfo[] {
    return [
      {
        provider: this.provider,
        model: "demo-1",
        efforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        defaultEffort: "medium",
      },
    ];
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const last = request.items.at(-1)?.item;

    if (last?.type === "tool_result") {
      const text = "Done — ran your message through the command tool.";
      await delay(DEMO_LATENCY_MS, signal);
      if (signal.aborted) return;
      yield { type: "text_delta", text };
      yield { type: "completed", usage: ZERO_USAGE };
      return;
    }

    const lastUser = [...request.items]
      .reverse()
      .map((i) => i.item)
      .find((i) => i.type === "message" && i.role === "user");
    const youSaid = lastUser && lastUser.type === "message" ? textOf(lastUser.content) : "";

    await delay(DEMO_LATENCY_MS, signal);
    if (signal.aborted) return;
    const tools = request.tools ?? [];
    const shell = tools.some((tool) => tool.name === "powershell")
      ? "powershell"
      : tools.some((tool) => tool.name === "bash")
        ? "bash"
        : undefined;
    if (!shell) throw new Error("demo provider requires a bash or powershell tool");
    yield {
      type: "tool_call",
      callId: `call-${++this.#calls}`,
      name: shell,
      args: {
        command:
          shell === "powershell"
            ? `Write-Output ${powershellQuote(youSaid)}`
            : `printf '%s\\n' ${bashQuote(youSaid)}`,
      },
    };
    yield { type: "completed", usage: ZERO_USAGE };
  }
}
