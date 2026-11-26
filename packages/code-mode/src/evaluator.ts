import { Worker } from "node:worker_threads";
import {
  defaultHostTimeouts,
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
  constructor(private readonly cpuMs = defaultHostTimeouts.codeCpuSeconds * 1000) {}
  async evaluate(
    code: string,
    tools: CodeToolBridge,
    signal: AbortSignal,
    emit: (blocks: ContentBlock[]) => Promise<void>,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    const outputAck = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { code, limits: { ...CODE_LIMITS, cpuMs: this.cpuMs }, outputAck },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    let writing: Promise<void> | undefined;
    let encodedImageBytes = 0;
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
    const append = async (blocks: ContentBlock[]) => {
      if (!Array.isArray(blocks)) throw new Error("emitContent expects an array of content blocks");
      // Stop at the first invalid block rather than building a potentially enormous list of
      // validation errors. Do not deliver a partial batch if a later block is rejected.
      for (const raw of blocks) {
        const block = contentBlockSchema.parse(raw);
        if (block.type !== "image") continue;
        outputImageBytes += imageByteLength(block.data);
        encodedImageBytes += JSON.stringify(block).length + 1;
        if (outputImageBytes > MAX_IMAGE_BYTES || encodedImageBytes + 1 > MAX_IMAGE_CONTENT_BYTES)
          throw new Error("code image output limit exceeded");
      }
      await emit(blocks);
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
        writing = append(message.content).then(
          () => {
            Atomics.store(outputAck, 0, 1);
            Atomics.notify(outputAck, 0);
          },
          (error: Error) => finish({ type: "done", error: error.message }),
        );
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
      await writing;
      if (outcome.value !== undefined && outcome.error === undefined) {
        try {
          await emit([{ type: "text", text: outcome.value }]);
        } catch (error) {
          outcome.error = (error as Error).message;
        }
      }
      if (outcome.error !== undefined)
        return errorResult(outcome.error.slice(0, 2048) || "code execution failed");
      return { forModel: [], status: "ok" };
    } finally {
      open = false;
      signal.removeEventListener("abort", onAbort);
      await worker.terminate();
      // Core cancels and drains descendants after this evaluator returns. Host callbacks cannot
      // touch the terminated guest because open is false; no QuickJS handles cross this boundary.
    }
  }
}
