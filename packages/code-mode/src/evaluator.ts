import { Worker } from "node:worker_threads";
import {
  contentBlockSchema,
  errorResult,
  imageByteLength,
  imageContentsSchema,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_CONTENT_BYTES,
  type CodeEvaluator,
  type CodeToolBridge,
  type ContentBlock,
  type ToolResult,
} from "@harness/protocol";

/** Fixed foreground limits; approval/tool waiting is excluded from guest CPU time. */
export const CODE_LIMITS = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  cpuMs: 1000,
  outputBytes: 64 * 1024,
  imageContentBytes: MAX_IMAGE_CONTENT_BYTES,
  bridgeBytes: 1024 * 1024,
  totalBridgeBytes: 8 * 1024 * 1024,
  calls: 128,
  outstanding: 16,
} as const;

type WorkerMessage =
  | {
      type: "request";
      id: number;
      name: string;
      args?: unknown;
    }
  | { type: "emit"; content: ContentBlock[] }
  | { type: "done"; value?: string; error?: string };

/** A worker owns all guest handles; the host owns tool lifetimes and recorded invocation. */
export class QuickJsEvaluator implements CodeEvaluator {
  async evaluate(code: string, tools: CodeToolBridge, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { code, limits: CODE_LIMITS },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    const content: ContentBlock[] = [];
    let outputBytes = 0;
    let outputImageBytes = 0;
    let bridgeBytes = 0;
    let calls = 0;
    let open = true;
    const outstanding = new Set<Promise<void>>();
    let finish!: (message: Extract<WorkerMessage, { type: "done" }>) => void;
    const done = new Promise<Extract<WorkerMessage, { type: "done" }>>((resolve) => {
      finish = (message) => {
        if (open) {
          open = false;
          resolve(message);
        }
      };
    });
    const onAbort = () => finish({ type: "done", error: "interrupted: code invocation cancelled" });
    signal.addEventListener("abort", onAbort, { once: true });
    const append = (blocks: ContentBlock[]) => {
      const validated = contentBlockSchema.array().parse(blocks);
      const images = validated.filter((block) => block.type === "image");
      const imageBytes = images.reduce((total, image) => total + imageByteLength(image.data), 0);
      const bytes = Buffer.byteLength(
        JSON.stringify(validated.filter((block) => block.type === "text")),
      );
      if (outputBytes + bytes > CODE_LIMITS.outputBytes)
        throw new Error("code output limit exceeded");
      if (outputImageBytes + imageBytes > MAX_IMAGE_BYTES)
        throw new Error("code image output limit exceeded");
      outputBytes += bytes;
      outputImageBytes += imageBytes;
      content.push(...validated);
    };
    worker.on("error", (error: Error) =>
      finish({ type: "done", error: `code worker failed: ${error.message}` }),
    );
    worker.on("exit", (exitCode) => {
      if (open)
        finish({ type: "done", error: `code worker exited before completion (${exitCode})` });
    });
    worker.on("message", (message: WorkerMessage) => {
      if (!open) return;
      if (message.type === "done") {
        finish(message);
        return;
      }
      if (message.type === "emit") {
        try {
          append(message.content);
        } catch (error) {
          finish({ type: "done", error: (error as Error).message });
        }
        return;
      }
      if (++calls > CODE_LIMITS.calls || outstanding.size >= CODE_LIMITS.outstanding) {
        finish({ type: "done", error: "code tool submission limit exceeded" });
        return;
      }
      const requestBytes = Buffer.byteLength(JSON.stringify(message));
      if (
        requestBytes > CODE_LIMITS.bridgeBytes ||
        (bridgeBytes += requestBytes) > CODE_LIMITS.totalBridgeBytes
      ) {
        finish({ type: "done", error: "code request data limit exceeded" });
        return;
      }
      const work = (async () => {
        try {
          signal.throwIfAborted();
          const result = await tools.call(message.name, message.args);
          const images = imageContentsSchema.parse(
            result.forModel.filter((block) => block.type === "image"),
          );
          const value = JSON.stringify(result);
          const bytes = Buffer.byteLength(value);
          const imageBytes = images.reduce((total, image) => total + image.data.length, 0);
          if (
            bytes - imageBytes > CODE_LIMITS.bridgeBytes ||
            bytes > CODE_LIMITS.bridgeBytes + CODE_LIMITS.imageContentBytes ||
            bridgeBytes + bytes > CODE_LIMITS.totalBridgeBytes
          ) {
            throw new Error("code tool data limit exceeded");
          }
          bridgeBytes += bytes;
          if (open) worker.postMessage({ id: message.id, value });
        } catch (error) {
          if (open)
            worker.postMessage({
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      })();
      outstanding.add(work);
      void work.finally(() => outstanding.delete(work));
    });
    try {
      const outcome = await done;
      if (outcome.value !== undefined && outcome.error === undefined) {
        try {
          append([{ type: "text", text: outcome.value }]);
        } catch (error) {
          outcome.error = (error as Error).message;
        }
      }
      if (outcome.error !== undefined)
        content.push(
          ...errorResult(outcome.error.slice(0, 2048) || "code execution failed").forModel,
        );
      if (content.length === 0) content.push({ type: "text", text: "null" });
      return { forModel: content, status: outcome.error !== undefined ? "error" : "ok" };
    } finally {
      open = false;
      signal.removeEventListener("abort", onAbort);
      await worker.terminate();
      // Core cancels and drains descendants after this evaluator returns. Host callbacks cannot
      // touch the terminated guest because open is false; no QuickJS handles cross this boundary.
    }
  }
}
