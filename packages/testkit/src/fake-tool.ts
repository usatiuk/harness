import {
  errorResult,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "@harness/protocol";
import { awaitReleaseOrAbort } from "./gate.ts";

/** Echoes its JSON args back as the model-facing result. */
export class EchoTool implements Tool {
  readonly name = "echo";
  readonly schema = {
    name: "echo",
    description: "Echoes its arguments back.",
    parameters: { type: "object", additionalProperties: true },
  };

  execute(args: unknown): Promise<ToolResult> {
    return Promise.resolve({
      forModel: [{ type: "text", text: JSON.stringify(args) }],
      status: "ok",
    });
  }
}

/**
 * A tool that blocks until `release()`, to hold a turn open at the dispatch
 * boundary. `started` resolves when `execute` is entered. `honorSignal: true` makes
 * it cooperative (errors on abort); the default ignores the signal, so interrupt
 * must abandon it.
 */
export class GateTool implements Tool {
  readonly name: string;
  readonly schema: ToolSchema;
  readonly started: Promise<void>;
  readonly #honorSignal: boolean;
  #markStarted!: () => void;
  #open!: () => void;
  readonly #gate: Promise<void>;

  constructor(opts: { name?: string; honorSignal?: boolean } = {}) {
    this.name = opts.name ?? "gate";
    this.schema = {
      name: this.name,
      description: "Blocks until released.",
      parameters: { type: "object" },
    };
    this.#honorSignal = opts.honorSignal ?? false;
    this.started = new Promise<void>((resolve) => (this.#markStarted = resolve));
    this.#gate = new Promise<void>((resolve) => (this.#open = resolve));
  }

  /** Unblocks the in-flight call. */
  release(): void {
    this.#open();
  }

  async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    this.#markStarted();
    if (this.#honorSignal) {
      await awaitReleaseOrAbort(this.#gate, ctx.signal);
      if (ctx.signal.aborted) {
        return errorResult("cancelled");
      }
    } else {
      await this.#gate;
    }
    return { forModel: [{ type: "text", text: "released" }], status: "ok" };
  }
}
